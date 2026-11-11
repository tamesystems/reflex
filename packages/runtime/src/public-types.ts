export interface StateChanged {
  readonly _tag: "StateChanged"
}
export interface NavigationRefused {
  readonly _tag: "NavigationRefused"
  readonly reason: string
}
export declare const terminal: unique symbol
export declare const navigationOwner: unique symbol
interface AnyNavigationCommand {
  readonly [terminal]: string
  readonly kind: "navigation"
}
export type NavigationCommand<K extends string = string> = string extends K
  ? AnyNavigationCommand
  : AnyNavigationCommand & {
      readonly [terminal]: K
      readonly [navigationOwner]: (key: K) => K
    }
export type ActionOutcome<E = never> =
  | { readonly status: "completed" | "cancelled" }
  | { readonly status: "error"; readonly error: E }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "defect"; readonly message: string }
