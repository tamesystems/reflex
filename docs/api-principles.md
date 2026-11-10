# API principles

The scoring standard for reviewing Reflex's application-author-facing APIs (`defineCapability`, `defineNavigation`, `defineApp`, `defineStoreNode`, `defineStoreApp`, the React, Expo Router and React Router hooks, and journeys). Define a contract once, attach it to a runtime value, and derive every consumer type from it. These principles also judge ceremony, lifetimes, naming and teaching.

North star: APIs "should be easy to use and hard to misuse. It should be easy to do simple things; possible to do complex things; and impossible, or at least difficult, to do wrong things" (Bloch). Users should "simply fall into winning practices" (Mariani, the Pit of Success).

## 1. Principles

### P1. The common case is one short, obvious expression

**Why.** Users judge an API by its first ten lines. Bloch: "When in doubt, leave it out". Conceptual weight matters more than the count of functions.
**Pattern (Zustand).**

```ts
const useBears = create<{ bears: number; add: () => void }>()((set) => ({
  bears: 0,
  add: () => set((s) => ({ bears: s.bears + 1 })),
}))
const bears = useBears((s) => s.bears)
```
**Prevents.** A provider, a reducer, action constants and a registry, all before one counter works.

### P2. Define once, infer everything; no generics at call sites

**Why.** Restated types drift and widen literals. The definition is the only place a type may be written, and a type annotation there is a cost to minimise. Zustand's `create<T>()` currying is a documented workaround for TS#10571, not a model.
**Pattern (Redux Toolkit `createSlice`).**

```ts
const cart = createSlice({
  name: "cart",
  initialState: [] as Item[],
  reducers: {
    add: (s, a: PayloadAction<Item>) => {
      s.push(a.payload)
    },
  },
})
cart.actions.add(item) // typed creator
typeof cart.actions.add.type // 'cart/add'
```
TanStack Query's `queryOptions` does the same thing: it tags the key with the data type, so `getQueryData` needs no generic.
**Prevents.** `useNode<CartState, CartActions>('cart')`, and `as` at call sites.

### P3. Typed end to end, from definition to UI

**Why.** The value is in the relationships between pieces. Action names, input shapes and state must flow from the node definition to the hook without a hand-written type in between.
**Pattern (tRPC).**

```ts
export type AppRouter = typeof appRouter
const trpc = createTRPCReact<AppRouter>()
trpc.post.byId.useQuery({ id: "1" }) // path, input and output all checked
```
React Router's generated `Route.ComponentProps` types `loaderData` from that module's own `loader` in the same way.
**Prevents.** `run('addItem', payload as any)`: string-keyed dispatch with an untyped payload, where a rename breaks at runtime.

### P4. Make misuse unrepresentable, including lifetimes

**Why.** Types that state invariants turn bugs into compile errors (Minsky: "make illegal states unrepresentable"; Bloch: "Fail fast… compile-time is best"). A resource whose release is optional will leak.
**Pattern (Effect `acquireRelease`).**

```ts
const conn = Effect.acquireRelease(open, (c) => Effect.promise(() => c.close()))
// conn: Effect<Conn, Error, Scope>: cannot run until a Scope is provided
const program = Effect.scoped(useConn(conn))
```
XState v5 `setup({ types })` does the same for events: sending an undeclared event type will not compile.
**Prevents.** A `subscribe()` with no matching unsubscribe, a `mount()` that is never disposed, and `{ isLoading, data, error }` bags whose fields can contradict each other.

### P5. One vocabulary, consistent across adapters

**Why.** "Names matter… code will read like prose" (Bloch). The same concept should have the same name and argument order in every binding. Rust's C-CONV gives conversions fixed prefixes so that users can predict names they have never seen.
**Pattern (TanStack Query adapters).**

```ts
// @tanstack/react-query, solid-query and vue-query share one options object
useQuery({ queryKey: ["todo", id], queryFn: () => fetchTodo(id) })
```
**Prevents.** `useNode` in React, `useReflexNode` in Expo and `useNodeState` in React Router, each taking `(id, opts)` in a different order.

### P6. Progressive disclosure, with honest escape hatches

**Why.** Defer advanced features to a second layer (NN/g). Rich Harris's tenet "Magical, not magic": convenience is welcome, but the layer below must be reachable and documented.
**Pattern (Hono).**

```ts
app.get("/books/:id", (c) => c.json({ id: c.req.param("id") })) // common case
app.get("/raw", (c) => fetch(c.req.raw)) // escape hatch: the real Request
```
**Prevents.** Two failures. Either every option is required up front, or there is no way down, so users cast to reach internals.

### P7. Type errors land at the caller's mistake; runtime errors say what to do

**Why.** An error inside a library's generic plumbing ("Type instantiation is excessively deep") is not actionable. A runtime error should name the node, the action and the field, and suggest a fix. `typescript-typesafety.md` §8 covers the type-level techniques.
**Pattern (Standard Schema).**

```ts
const r = schema["~standard"].validate(input)
if (r.issues)
  // each issue has a message and a path
  throw new Error(
    `cart.add: ${r.issues.map((i) => `${i.path?.join(".")}: ${i.message}`).join("; ")}`,
  )
```
**Prevents.** Bare `Invalid input` messages, `undefined is not a function` raised three layers deep, and errors reported against the library's own `.d.ts`.

### P8. Fit the host's idioms; do not fight them

**Why.** Users bring their habits from the host. Hooks must be called at the top level, only from components or custom hooks. Effect code expects services, `yield*` and typed errors. Store code expects selectors and immutable `set`.
**Pattern (Effect v4 service).**

```ts
class Inventory extends Context.Service<
  Inventory,
  {
    readonly stock: (sku: string) => Effect.Effect<number, NotFound>
  }
>()("Inventory") {}
const program = Effect.gen(function* () {
  return yield* (yield* Inventory).stock("a")
})
```
Zustand: selectors that return objects go through `useShallow`.
**Prevents.** A hook that calls hooks conditionally, Promise-returning functions inside Effect code, errors thrown where an Effect user expects them in the error channel, and a store adapter that mutates state outside `set`.

### P9. No internals leak into userland

**Why.** If app code needs `isRecord`, `JSON.parse(x) as T`, `as unknown as` or `_def`, the library has handed its own job to the user. Accept interop standards, not per-vendor adapters.
**Pattern (Standard Schema input; tRPC public inference).**

```ts
function mountStore<S extends StandardSchemaV1>(
  input: S /* Zod, Valibot, ArkType, Effect Schema */,
) {}
type Out = inferRouterOutputs<AppRouter>["post"]["byId"] // not AppRouter._def
```
**Prevents.** Casts and type guards scattered through example and app code, and user code that breaks whenever the library refactors its internals.

### P10. Tests read as user stories

**Why.** "The more your tests resemble the way your software is used, the more confidence they can give you" (Testing Library). A test should drive the public actions and assert on observable state, with dependencies swapped through the host's normal mechanism (Effect layers, store initial state).
**Pattern (XState v5).**

```ts
const actor = createActor(cartMachine).start()
actor.send({ type: "add", item })
actor.send({ type: "checkout" })
expect(actor.getSnapshot().value).toBe("paid")
```
**Prevents.** Tests that poke private state, mock the library itself, or need a different API from the one the app uses.

### P11. Examples teach the idiom; they are not demos

**Why.** "Example code should be exemplary… mistakes will come back to haunt you a thousand fold" (Bloch). Rust requires an example for every item, and requires those examples to use `?` rather than `unwrap` (C-EXAMPLE, C-QUESTION-MARK). Users copy examples, shortcuts included.
**Pattern (Rust API Guidelines).**

```rust
/// let cfg = Config::load(path)?;   // the idiom users will copy
/// let cfg = Config::load(path).unwrap();   // banned in docs
```
For a TS library this means the examples import only public entry points and contain no `any`, no casts and no `@ts-expect-error`. They should also compile in CI.
**Prevents.** An example app full of workarounds, which then become the de facto API.

### P12. Type-level precision is paid for in editor latency

**Why.** Every hook call can re-instantiate the app's full type graph. Hono warns: "the more routes you have, the slower your IDE will become." The TypeScript wiki advises named types, `interface extends` over intersections, and caution with unions of more than about a dozen members. A good API also lets callers narrow the type graph themselves, as TanStack Router does with `from`.
**Pattern (Hono split clients).**

```ts
const authors = hc<typeof authorsApp>("/authors") // instantiates only this sub-app's routes
```
**Prevents.** A hook signature that is one huge union of every node and action, with type checking on autocomplete slow enough that users disable it or reach for `any`.

## 2. Scoring rubric

Score each factor from 1 to 10. The anchors below describe 5, 7, 9 and 10.

| Factor                               | 5                                                                 | 7                                                                    | 9                                                                       | 10                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Common-case brevity (P1)**         | Works, but needs setup and ceremony beyond the domain.            | Short, with one or two concepts to learn first.                      | The minimal example is about as long as the Zustand or RTK equivalent.  | The shortest correct code is the code you would write anyway; nothing left to remove.   |
| **Inference (P2)**                   | Call sites need some generics or annotations.                     | Inferred except in edge cases, which are documented.                 | Zero call-site generics; the definition needs at most one annotation.   | Zero annotations anywhere a value can carry the type; literals are preserved.           |
| **End-to-end typing (P3)**           | State is typed; action names or inputs are strings or `unknown`.  | Names and inputs are typed, with gaps at one adapter or in journeys. | Typed from definition through every hook and journey.                   | Renaming an action is a compile error at every use, including tests and navigation.     |
| **Misuse resistance (P4)**           | Invariants live in docs.                                          | The main invariants are in types; lifetimes are managed by hand.     | Invalid states and calls do not compile; lifetimes are scoped.          | Hard to write a leak, a double mount or a stale subscription even on purpose.           |
| **Naming and consistency (P5)**      | Each adapter invents its own names.                               | Mostly consistent, with a few odd names or argument orders.          | One vocabulary across Effect, store and all three hosts.                | You can guess an unseen adapter's API from another one and be right.                    |
| **Layering and escape hatches (P6)** | Either everything is required or nothing can be configured.       | Sensible defaults; escape hatches are undocumented.                  | Clear tiers; each escape hatch is typed and documented.                 | Each layer stands alone, and dropping down never needs a cast.                          |
| **Errors (P7)**                      | Type errors point into library types; runtime errors are generic. | Most errors land at the call site; messages name the field.          | Errors name the node, action and path, and suggest a fix.               | Every reachable error is tested for its message and location.                           |
| **Host idiom fit (P8)**              | Usable, but feels foreign in the host.                            | Follows the host's rules, with some friction.                        | Indistinguishable from first-party code in React, Effect and the store. | Experts in the host find nothing to unlearn, and the linters pass untouched.            |
| **No leaked internals (P9)**         | App code needs casts or guards.                                   | Occasional `as` or helper imports from internal paths.               | No casts, guards or JSON plumbing anywhere in userland.                 | Public types are the only surface, and their `.d.ts` reads as documentation.            |
| **Testability (P10)**                | Tests need mocks of the library or of its internals.              | Tests use the public API, with setup noise.                          | Journeys read as user stories, with typed steps and layer swaps.        | The same journey runs against fixtures and the live app unchanged.                      |
| **Examples (P11)**                   | Examples drift or use workarounds.                                | Correct, but show shortcuts or casts.                                | Idiomatic, compiled in CI, every public item covered.                   | The examples alone are enough to learn the idiom.                                       |
| **Type performance (P12)**           | Noticeable editor lag in the example app.                         | Acceptable, but grows with every node.                               | Hot paths are narrowed, cost is measured, and per-node cost stays flat. | Budgets are tracked in CI with `--extendedDiagnostics`, and regressions fail the build. |

## 3. Sources

- Bloch, How to Design a Good API and Why it Matters (OOPSLA 2006): https://www.cin.ufpe.br/~if669/files/MaterialDeEnsino/Referencias/api-design-oopsla-2006.pdf
- Bloch interview, InfoQ: https://www.infoq.com/articles/API-Design-Joshua-Bloch
- Mariani via Abrams, The Pit of Success: https://learn.microsoft.com/en-us/archive/blogs/brada/the-pit-of-success
- Atwood, Falling Into the Pit of Success: https://blog.codinghorror.com/falling-into-the-pit-of-success/
- Make illegal states unrepresentable (Minsky; Wlaschin): https://fsharpforfunandprofit.com/posts/designing-with-types-making-illegal-states-unrepresentable/
- Rich Harris, Svelte Tenets: https://github.com/sveltejs/svelte/discussions/10085
- Dan Abramov, Why Do Hooks Rely on Call Order?: https://overreacted.io/why-do-hooks-rely-on-call-order/
- React, Rules of Hooks: https://react.dev/reference/rules/rules-of-hooks
- NN/g, Progressive Disclosure: https://www.nngroup.com/articles/progressive-disclosure/
- Rust API Guidelines checklist: https://rust-lang.github.io/api-guidelines/checklist.html
- Zustand, Beginner and Advanced TypeScript: https://zustand.docs.pmnd.rs/learn/guides/beginner-typescript, https://zustand.docs.pmnd.rs/learn/guides/advanced-typescript
- Redux Toolkit, Usage with TypeScript: https://redux.js.org/toolkit/usage/usage-with-typescript
- TkDodo, The Query Options API: https://tkdodo.eu/blog/the-query-options-api
- TanStack Router, Type Safety: https://tanstack.com/router/latest/docs/framework/react/guide/type-safety
- tRPC React client: https://trpc.io/docs/client/react/useUtils
- React Router, Route Module Type Safety: https://reactrouter.com/how-to/route-module-type-safety
- XState v5 setup: https://stately.ai/docs/setup
- Effect v4, Services and Scope: https://effect.website/docs/v4/requirements-management/services.md, https://effect.website/docs/v4/resource-management/scope.md
- Standard Schema: https://standardschema.dev/
- Hono RPC: https://hono.dev/docs/guides/rpc
- Testing Library, Guiding Principles: https://testing-library.com/docs/guiding-principles
- TypeScript Performance wiki: https://github.com/microsoft/TypeScript/wiki/Performance
