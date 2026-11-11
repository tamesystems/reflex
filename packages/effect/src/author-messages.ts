/** Diagnostics shared by headless and live controllers through the node runtime. */
export const authorMessages = {
  navigationReturn: "action.navigates must return a NavigationCommand",
  plainNavigation: "Use action.navigates for actions that navigate",
  discardedCommand: "Return the NavigationCommand from action.navigates; a command was discarded",
  refusalRecovery: "Navigation refusal recovery must return void without issuing commands",
  foreignNavigator: (action: string, key: string, names: readonly string[]) =>
    `Action ${action} requires navigator '${key}' (${names.join(", ")}); use commands from the app's navigation`,
} as const
