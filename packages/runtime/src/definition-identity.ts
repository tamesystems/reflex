/** Shared identity boundary; implementations retain the contract's token. */
export const DEFINITION_IDENTITY = Symbol.for("@reflex/definition")
export const definitionIdentity = (value: object): object =>
  DEFINITION_IDENTITY in value ? (value[DEFINITION_IDENTITY] as object) : value
