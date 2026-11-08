import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { dirname } from "node:path"

/** Windows mode bits are not ACLs. Fail closed, including on filesystems without ACLs. */
export const checkWindowsAcl = (path: string, createDirectory = false): void => {
  if (process.platform !== "win32") {
    return
  }
  if (createDirectory) {
    mkdirSync(dirname(path), { recursive: true })
  }
  const encodedPath = Buffer.from(path).toString("base64")
  const script = `
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if (${createDirectory ? "$true" : "$false"} -and -not [IO.Directory]::Exists($p)) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  $dir = [IO.DirectoryInfo]::new($p)
  $dir.Create($acl)
}
$item = Get-Item -LiteralPath $p -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not private storage' }
$acl = Get-Acl -LiteralPath $p
$raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
if ($null -eq $raw.DiscretionaryAcl) { throw 'Null DACL' }
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Untrusted owner' }
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) {
    throw 'Access granted to another principal'
  }
}
if (-not $acl.AreAccessRulesCanonical) { throw 'Noncanonical ACL' }
`
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { stdio: "pipe", windowsHide: true },
    )
  } catch (error: unknown) {
    const detail =
      error instanceof Error && "stderr" in error && Buffer.isBuffer(error.stderr)
        ? error.stderr.toString().replace(/\s+/g, " ").slice(0, 1000)
        : "ACL verification failed"
    throw new Error(
      `${path} must be accessible only to its owner (Windows ACL; SYSTEM and Administrators allowed): ${detail}`,
    )
  }
}

export const preparePrivateDirectory = ({ directory }: { readonly directory: string }): void => {
  if (process.platform === "win32") {
    checkWindowsAcl(directory, true)
    return
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if ((statSync(directory).mode & 0o077) !== 0) {
    throw new Error(`${directory} must be accessible only to its owner`)
  }
}

/** Existing secrets must not have broader explicit permissions than their directory. */
export const checkSecretAcl = (path: string): void => {
  if (process.platform === "win32" && existsSync(path)) {
    checkWindowsAcl(path)
  }
}
