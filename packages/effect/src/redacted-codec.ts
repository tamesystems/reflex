import {
  assertNever,
  ErrorCode,
  isRecord,
  ProtocolError,
  SCHEMA_DEPTH_MAX,
  SCHEMA_NODES_MAX,
} from "@reflex/protocol"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import { REDACTED_TEXT } from "./redaction.ts"

/**
 * Publishing describes a redacted view, not an input the app accepts. The
 * original schema validates real secrets; this codec replaces their entire
 * encoding, including RedactedFromValue's links. No secret refinement or
 * transformation is ever applied to placeholder text.
 */
export const redactedCodec = (
  schema: Schema.Codec<unknown, unknown>,
): Schema.Codec<unknown, unknown> => {
  const copies = new Map<SchemaAST.AST, SchemaAST.AST>()
  let schemaNodeCount = 0
  const rewrite = (ast: SchemaAST.AST, depth: number): SchemaAST.AST => {
    const existing = copies.get(ast)
    if (existing !== undefined) {
      return existing
    }
    if (depth > SCHEMA_DEPTH_MAX || schemaNodeCount >= SCHEMA_NODES_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Schema is too large to publish")
    }
    schemaNodeCount++
    const representation = ast.annotations?.representation
    const secret =
      ast._tag === "Declaration" &&
      isRecord(representation) &&
      representation.id === "effect/schema/Redacted"
    const child = (value: SchemaAST.AST) => rewrite(value, depth + 1)
    const copy = secret ? redactedDeclaration(ast, representation.payload) : copyNode(ast, child)
    // Encoding links may have erased the secret's declaration (e.g. encodeKeys
    // keeps an encoded enum or number). Permit the marker at every boundary so
    // that its original wire representation never rejects placeholder text.
    // Try the real codec first: ordinary text equal to the marker must still
    // undergo its own transformations.
    const view = new SchemaAST.Union(
      [copy, new SchemaAST.Literal(REDACTED_TEXT)],
      undefined,
      undefined,
      undefined,
      undefined,
      ast.context,
    )
    copies.set(ast, view)
    return view
  }
  return Schema.make<Schema.Codec<unknown, unknown>>(rewrite(schema.ast, 0))
}

const redactedDeclaration = (source: SchemaAST.AST, payload: unknown): SchemaAST.Declaration => {
  const placeholder = Schema.Redacted(Schema.String, {
    disallowJsonEncode: isRecord(payload) && payload.disallowJsonEncode === true,
  }).ast
  // RedactedFromValue must still unwrap before an enclosing key-renaming link.
  // Use a fresh unrefined link, never the original secret's encoding pipeline.
  const encoding =
    source.encoding === undefined ? undefined : Schema.RedactedFromValue(Schema.String).ast.encoding
  return new SchemaAST.Declaration(
    placeholder.typeParameters,
    placeholder.run,
    placeholder.annotations,
    undefined,
    encoding,
    source.context,
    undefined,
    placeholder.encodingRun,
  )
}

type Rewrite = (ast: SchemaAST.AST) => SchemaAST.AST

/** Use public AST constructors so Effect upgrades typecheck this adapter. */
const copyNode = (ast: SchemaAST.AST, child: Rewrite): SchemaAST.AST => {
  const { annotations, context } = ast
  // The original decoded value was already validated. A check on a parent can
  // inspect a secret too, so no checks run on the projected view.
  const checks = undefined
  const rewriteLink = (link: SchemaAST.Link) =>
    new SchemaAST.Link(child(link.to), link.transformation)
  const encoding: SchemaAST.Encoding | undefined =
    ast.encoding === undefined
      ? undefined
      : [rewriteLink(ast.encoding[0]), ...ast.encoding.slice(1).map(rewriteLink)]
  switch (ast._tag) {
    case "Declaration":
      return new SchemaAST.Declaration(
        ast.typeParameters.map(child),
        ast.run,
        annotations,
        checks,
        encoding,
        context,
        undefined,
        ast.encodingRun,
      )
    case "Arrays":
      return new SchemaAST.Arrays(
        ast.isMutable,
        ast.elements.map(child),
        ast.rest.map(child),
        annotations,
        checks,
        encoding,
        context,
        undefined,
      )
    case "Objects":
      return new SchemaAST.Objects(
        ast.propertySignatures.map(
          (property) => new SchemaAST.PropertySignature(property.name, child(property.type)),
        ),
        // Index parameters have their own AST grammar and cannot hold Redacted keys.
        ast.indexSignatures.map(
          (index) => new SchemaAST.IndexSignature(index.parameter, child(index.type)),
        ),
        annotations,
        checks,
        encoding,
        context,
        undefined,
      )
    case "Union":
      return new SchemaAST.Union(
        ast.types.map(child),
        ast.options,
        annotations,
        checks,
        encoding,
        context,
        undefined,
      )
    case "Suspend":
      return new SchemaAST.Suspend(() => child(ast.thunk()), annotations, checks, encoding, context)
    default:
      return copyLeaf(ast, encoding)
  }
}

const copyLeaf = (
  ast: Exclude<
    SchemaAST.AST,
    | SchemaAST.Declaration
    | SchemaAST.Arrays
    | SchemaAST.Objects
    | SchemaAST.Union
    | SchemaAST.Suspend
  >,
  encoding: SchemaAST.Encoding | undefined,
): SchemaAST.AST => {
  const { annotations, context } = ast
  const checks = undefined
  switch (ast._tag) {
    case "TemplateLiteral":
      return new SchemaAST.TemplateLiteral(ast.parts, annotations, checks, encoding, context)
    case "Literal":
      return new SchemaAST.Literal(ast.literal, annotations, checks, encoding, context)
    case "Enum":
      return new SchemaAST.Enum(ast.enums, annotations, checks, encoding, context)
    case "UniqueSymbol":
      return new SchemaAST.UniqueSymbol(ast.symbol, annotations, checks, encoding, context)
    case "Null":
    case "Undefined":
    case "Void":
    case "Never":
    case "Any":
    case "Unknown":
    case "ObjectKeyword":
    case "String":
    case "Number":
    case "Boolean":
    case "Symbol":
    case "BigInt":
      return new LEAF_CONSTRUCTORS[ast._tag](annotations, checks, encoding, context)
    default:
      return assertNever(ast)
  }
}

const LEAF_CONSTRUCTORS = {
  Null: SchemaAST.Null,
  Undefined: SchemaAST.Undefined,
  Void: SchemaAST.Void,
  Never: SchemaAST.Never,
  Any: SchemaAST.Any,
  Unknown: SchemaAST.Unknown,
  ObjectKeyword: SchemaAST.ObjectKeyword,
  String: SchemaAST.String,
  Number: SchemaAST.Number,
  Boolean: SchemaAST.Boolean,
  Symbol: SchemaAST.Symbol,
  BigInt: SchemaAST.BigInt,
}
