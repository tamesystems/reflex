import { expect, test } from "bun:test"
import { reportActionOutcome, type ActionOutcome } from "../src/node-handle.ts"
const expected: ActionOutcome<string> = {
  status: "domain-error",
  error: { defect: false, tag: "Expected", message: "try again", data: "safe" },
}
test("awaited expected action errors do not report twice", async () => {
  const errors: unknown[] = []
  const result = await reportActionOutcome(Promise.resolve(expected), (error) => errors.push(error))
  expect(result).toBe(expected)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(errors).toEqual([])
})
test("ignored expected errors and defects still report", async () => {
  const errors: unknown[] = []
  void reportActionOutcome(Promise.resolve(expected), (error) => errors.push(error))
  const defect = await reportActionOutcome(
    Promise.resolve({
      status: "defect",
      error: { tag: "Defect", message: "broken", defect: true },
    }),
    (error) => errors.push(error),
  )
  expect(defect.status).toBe("defect")
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(errors.map(String)).toEqual(["Error: Defect: broken", "Error: Expected: try again"])
})
