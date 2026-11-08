# Implementing Shopify's Reflex architecture in an Expo app

I would approach this as building a Reflex-inspired development platform for Expo, rather than trying to port Shopify's implementation directly.

The goal would be to make an Expo application behave more like a continuously running development environment: code changes should appear quickly, development tooling should be integrated, and developers should spend less time waiting for builds, navigating between tools, or reconstructing application state.

Expo already provides some of the underlying capabilities through Metro, Fast Refresh, development builds, and Expo Router. The opportunity is to combine these into a more cohesive system and add the capabilities that aren't available out of the box.

The key architectural decision is to build on Expo's existing development infrastructure instead of replacing Metro or React Native's runtime.

## 1. What Reflex actually does

After reading [Shopify's Reflex article](https://shopify.engineering/reflex?utm_source=chatgpt.com), the important distinction is that Reflex is primarily about headless, agent-driven application testing, not faster hot reloading.

Shopify designed Reflex around four pillars:

1.  Headless core: Application logic runs without React Native, a simulator, or a rendered interface.
2.  Strict ViewModel contract: Screens accept actions and expose state, with a single reducer controlling state transitions.
3.  Introspection: An external process can discover the current screen, inspect its JSON state, and invoke supported actions.
4.  CLI-driven behavior tests: Coding agents can explore and test complete user journeys through a terminal.

Shopify reports running more than 1,700 behavior tests in approximately four minutes across its two native implementations. That's a useful benchmark, not a performance guarantee for Expo.

The especially interesting part for Expo is that JavaScript and TypeScript make the headless architecture easier to achieve. We can run the same application core in Node.js and React Native without implementing separate Swift and Kotlin cores.

## 2. Proposed architecture

Both the Expo UI and the headless CLI construct the same application core. Only the service adapters differ.

I would implement this as a TypeScript monorepo:

    apps/
      mobile/                 # Expo application
        app/                  # Expo Router screens
        src/adapters/         # Native service implementations
        src/providers/        # Core-to-React bindings

    packages/
      core/
        src/
          app/                # Application composition
          navigation/         # Headless navigation state
          features/
            inventory/
              model.ts
              view-model.ts
              introspection.ts
          services/           # Dependency interfaces

      reflex/
        src/
          node.ts             # Introspection contract
          protocol.ts         # JSON command definitions
          runner.ts           # Headless session
          cli.ts              # Terminal interface

      fixtures/
        inventory.ts
        scenarios/

    tests/
      journeys/
        inventory.test.ts

The dependency rule is critical:

`core` must never import `expo-*`, `react-native`, `expo-router`, React hooks, or browser/device APIs.

The Expo application depends on the core, but the core doesn't know Expo exists.

## 3. Implement a ViewModel contract

I'd use a lightweight Elm-style state machine with a reducer and explicit effects.

For example, consider an inventory detail screen where the user can change the quantity of a product.

    type InventoryState = {
      productId: string;
      title: string;
      quantity: number;
      saving: boolean;
      error: string | null;
    };

    type InventoryAction =
      | { type: "increment" }
      | { type: "decrement" }
      | { type: "setQuantity"; quantity: number }
      | { type: "save" };

    type InventoryMessage =
      | InventoryAction
      | { type: "saveSucceeded" }
      | { type: "saveFailed"; error: string };

    interface InventoryService {
      saveQuantity(id: string, quantity: number): Promise<void>;
    }

    type Listener = () => void;

    export class InventoryViewModel {
      private current: InventoryState;
      private listeners = new Set<Listener>();

      constructor(
        initial: InventoryState,
        private service: InventoryService
      ) {
        this.current = initial;
      }

      get state(): Readonly<InventoryState> {
        return this.current;
      }

      subscribe = (listener: Listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      };

      private update(message: InventoryMessage) {
        const state = this.current;

        switch (message.type) {
          case "increment":
            this.current = {
              ...state,
              quantity: state.quantity + 1,
            };
            break;

          case "decrement":
            this.current = {
              ...state,
              quantity: Math.max(0, state.quantity - 1),
            };
            break;

          case "setQuantity":
            this.current = {
              ...state,
              quantity: Math.max(0, message.quantity),
            };
            break;

          case "save":
            this.current = { ...state, saving: true, error: null };
            break;

          case "saveSucceeded":
            this.current = { ...state, saving: false };
            break;

          case "saveFailed":
            this.current = {
              ...state,
              saving: false,
              error: message.error,
            };
            break;
        }

        for (const listener of this.listeners) listener();
      }

      async send(action: InventoryAction): Promise<void> {
        if (action.type !== "save") {
          this.update(action);
          return;
        }

        if (this.current.saving) return;

        this.update(action);

        try {
          await this.service.saveQuantity(
            this.current.productId,
            this.current.quantity
          );
          this.update({ type: "saveSucceeded" });
        } catch (error) {
          this.update({
            type: "saveFailed",
            error: String(error),
          });
        }
      }
    }

This is an illustrative first implementation. In production, I'd also handle stale asynchronous responses, disposal, and action serialization.

The important properties are:

- State has one writer: `update`.
- Public actions are typed.
- Service results return as internal messages.
- The service is injected.
- The ViewModel can be instantiated in Node without Expo.

For larger applications, I'd consider using a state-machine library such as XState, but I wouldn't introduce one initially. Shopify's approach benefits from a small, predictable contract.

## 4. Add the introspection layer

This is the most important piece of Reflex.

Each ViewModel exposes a JSON-readable representation of itself and the actions it accepts.

I'd use Zod for action validation and JSON Schema generation.

    import { z } from "zod";
    import type { InventoryViewModel } from "./view-model";

    const SetQuantityInput = z.object({
      quantity: z.number().int().nonnegative(),
    });

    export function inventoryNode(vm: InventoryViewModel) {
      return {
        name: "InventoryDetail",

        get state() {
          return vm.state;
        },

        actions: {
          Increment: {
            schema: z.object({}),
            run: () => vm.send({ type: "increment" }),
          },

          Decrement: {
            schema: z.object({}),
            run: () => vm.send({ type: "decrement" }),
          },

          SetQuantity: {
            schema: SetQuantityInput,
            run: (raw: unknown) => {
              const { quantity } = SetQuantityInput.parse(raw);
              return vm.send({ type: "setQuantity", quantity });
            },
          },

          Save: {
            schema: z.object({}),
            run: () => vm.send({ type: "save" }),
          },
        },
      };
    }

The CLI should expose the available actions and their JSON input schemas. A generic dispatcher validates input and invokes `run`.

An agent could then interact with the application using:

Headless agent session

Illustrative CLI output

\$ reflex ls\
{\
"name": "InventoryDetail",\
"state": {\
"title": "Blue T-Shirt",\
"quantity": 5,\
"saving": false,\
"error": null\
},\
"actions": \[\
"Increment", "Decrement",\
"SetQuantity", "Save", "GoBack"\
\]\
}

\$ reflex do SetQuantity '{"quantity":12}'\
✓ Action completed\
\$ reflex ls\
{\
"name": "InventoryDetail",\
"state": {\
"title": "Blue T-Shirt",\
"quantity": 12,\
"saving": false,\
"error": null\
}\
}

The `GoBack` action in this example would come from the navigation node, not from the Inventory ViewModel.

This separation is important: the introspection layer must not contain business rules. It only describes and invokes the ViewModel's public actions.

## 5. Integrate with Expo Router

This is the part that requires the most architectural thought.

Shopify's navigation lives inside its headless core. Expo Router, by contrast, derives navigation from React Navigation and a file-based route structure.

I see two approaches:

Option A — Expo Router owns navigation

Keep `router.push()`, `router.back()`, and React Navigation as the source of truth. Introspection can expose screen actions, but headless journey testing would need a separate navigation simulation.

Easiest to retrofit into an existing app, but doesn't fully reproduce Reflex.

Simpler

Option B — Core owns navigation

Implement a small headless navigator that tracks routes, parameters, stacks, tabs, and modals. Expo Router becomes a projection of that navigation state.

More architectural work, but lets agents navigate the entire application without rendering anything.

Preferred

For a new application, I would choose Option B.

For an existing Expo app, I'd start with Option A and migrate only when headless navigation testing becomes a priority.

### Headless navigation model

    type Route =
      | { name: "InventoryList" }
      | { name: "InventoryDetail"; productId: string }
      | { name: "Settings" };

    class AppNavigator {
      private stack: Route[] = [{ name: "InventoryList" }];

      get current(): Route {
        return this.stack[this.stack.length - 1];
      }

      push(route: Route) {
        this.stack = [...this.stack, route];
      }

      back() {
        if (this.stack.length > 1) {
          this.stack = this.stack.slice(0, -1);
        }
      }
    }

The real implementation would add subscriptions, state serialization, route lifecycle management, and modal/tab semantics.

The Expo adapter would synchronize that navigator with Expo Router:

    function routeToHref(route: Route) {
      switch (route.name) {
        case "InventoryList":
          return "/inventory" as const;
        case "InventoryDetail":
          return {
            pathname: "/inventory/[id]" as const,
            params: { id: route.productId },
          };
        case "Settings":
          return "/settings" as const;
      }
    }

I would avoid naive bidirectional synchronization between the two navigators. It can create loops and diverging histories.

Instead, define the core navigator as authoritative, have one adapter apply navigation commands to Expo Router, and route hardware back gestures, deep links, and user navigation back into core events. Also test cold starts and navigation restoration explicitly.

For a very navigation-heavy app, it's worth evaluating whether React Navigation's lower-level APIs offer a cleaner adapter than Expo Router's imperative methods.

## 6. Bind the ViewModel to React Native

The screen itself becomes very thin.

React's `useSyncExternalStore` is a good fit because the ViewModel already has a subscription API.

    import { useSyncExternalStore } from "react";
    import { View, Text, Button } from "react-native";
    import type { InventoryViewModel } from "@app/core";

    function useViewModel(vm: InventoryViewModel) {
      return useSyncExternalStore(
        vm.subscribe,
        () => vm.state
      );
    }

    export function InventoryDetailScreen({
      vm,
    }: {
      vm: InventoryViewModel;
    }) {
      const state = useViewModel(vm);

      return (
        <View>
          <Text>{state.title}</Text>
          <Text>Quantity: {state.quantity}</Text>

          <Button
            title="Increment"
            onPress={() => void vm.send({ type: "increment" })}
          />

          <Button
            title="Save"
            disabled={state.saving}
            onPress={() => void vm.send({ type: "save" })}
          />

          {state.error && <Text>{state.error}</Text>}
        </View>
      );
    }

The ViewModel must replace state objects immutably, as in the earlier example, so React detects snapshot changes.

Also, ViewModel instances should be owned by an application-level container, not recreated on each render.

Now the same ViewModel works in two environments:

- Expo: React subscribes to state and dispatches actions from touch events.
- Node.js: The CLI reads state and dispatches those same actions.

No renderer is necessary for the second environment.

## 7. Build the headless CLI

I would implement the first version in Node.js, using newline-delimited JSON over standard input/output.

That gives you a persistent application session without needing HTTP, WebSockets, Metro, or an emulator.

The protocol could be:

|            |                                          |
|------------|------------------------------------------|
| Command    | Purpose                                  |
| `ls`       | Get focused screen, state, and actions   |
| `do`       | Dispatch a validated action              |
| `tree`     | Inspect navigation and active ViewModels |
| `reset`    | Start a new fixture scenario             |
| `wait`     | Wait for a state predicate               |
| `scenario` | Load a named fixture                     |

The process would look like this:

    Coding agent
        |
        v
    reflex CLI
        |
        v
    JSON protocol (stdin/stdout)
        |
        v
    Headless app session
        |
        +-- Core navigator
        +-- Active ViewModels
        +-- Introspection registry
        +-- Fixture services

The `reflex do` command must send its action to a persistent process. Starting a new Node process for every command would lose the application state.

For an initial implementation, I would use a long-running child process and a small CLI client that connects through a local Unix socket or Windows named pipe. For test execution, the test runner can spawn the headless process directly.

## 8. Write behavior tests that agents can understand

This is where the architecture starts to pay off.

Instead of testing rendered buttons and waiting for animations, tests describe journeys through application state.

For example:

    import { test, expect } from "bun:test";
    import { createTestApp } from "../support/create-test-app";

    test("user updates inventory quantity", async () => {
      const app = createTestApp({
        scenario: "inventory-with-products",
      });

      await app.precondition("InventoryList");

      await app.do("OpenProduct", {
        productId: "product-123",
      });

      await app.precondition("InventoryDetail");

      await app.do("SetQuantity", {
        quantity: 12,
      });

      await app.do("Save");

      expect(app.state).toMatchObject({
        quantity: 12,
        saving: false,
        error: null,
      });

      expect(app.services.inventory.saved).toEqual([
        {
          productId: "product-123",
          quantity: 12,
        },
      ]);
    });

Here `createTestApp`, `precondition`, and `do` are proposed APIs to implement, not existing Expo or Bun functions.

The test harness should wait for expected state transitions rather than use fixed sleeps. A completed action should have explicit semantics: synchronous reducer completion, or awaited asynchronous effects.

### Deterministic fixtures

I would enforce the same principle Shopify uses: no uncontrolled network or device I/O in behavior tests.

Inject fixture-backed implementations of:

- API and GraphQL clients
- Authentication and session state
- Secure storage and AsyncStorage
- Feature flags
- Clock and timers
- Camera, location, and permissions

One subtle point: injecting fixtures isn't sufficient to guarantee isolation. I'd add a test-host network guard, fail on unexpected requests, and validate that no imported core module accesses native APIs.

The benefit is being able to reproduce conditions such as an expired session, an API failure, or denied permissions in milliseconds.

## 9. A particularly valuable extension: drive the real Expo app

Shopify also describes running its introspection protocol against a real application build.

I would add this after the headless system works.

For Expo, I would run the WebSocket server on the development machine and have the development build connect outward to it. This avoids trying to run a general-purpose socket server inside the React Native runtime.

A command such as:

    reflex --target device do Increment

would invoke the action on the live ViewModel. React Native would automatically rerender because it subscribes to that same instance.

The bridge should be development-only, explicitly enabled, authenticated, and limited to the introspection contract. It must never be exposed in production builds.

This would be particularly useful for coding agents: they could run most tests headlessly, then validate selected behavior against the real Expo app.

## 10. What I would build first

I would divide implementation into four milestones.

Milestone 1 — Headless core

Estimated 2–3 development days

Extract one feature into a pure TypeScript package. Implement its ViewModel, injected services, state subscriptions, and reducer tests.

Acceptance: The feature runs under Node without loading React Native.

Milestone 2 — Introspection and CLI

Estimated 2–4 development days

Implement the node contract, action schemas, persistent session, and `ls` / `do` commands.

Acceptance: An agent can inspect and modify feature state without an emulator.

Milestone 3 — Navigation and journey tests

Estimated 4–7 development days

Implement the core navigator, fixture scenarios, test SDK, and Expo Router adapter.

Acceptance: An agent can navigate between three screens and complete a deterministic user journey headlessly.

Milestone 4 — Live Expo bridge

Estimated 3–5 development days

Add a development-only bridge to the actual running Expo app, with a CLI target switch.

Acceptance: The same CLI actions work against both headless and live app sessions.

These are rough engineering estimates for a focused proof of concept, not a full application migration.

## 11. Design decisions I'd make differently from Shopify

|  |  |  |
|----|----|----|
| Area | Shopify Reflex | Proposed Expo implementation |
| Core runtime | Swift / Kotlin | Shared TypeScript |
| UI | SwiftUI / Compose | React Native |
| ViewModels | Native classes | TypeScript classes or state machines |
| Introspection | Native protocol + macros | TypeScript + Zod |
| Headless execution | macOS / JVM | Node.js / Bun |
| Navigation | Custom core navigator | Core navigator + Expo Router adapter |
| Platform parity | Same tests, separate code | Shared logic tests + native integration tests |
| Agent interface | CLI | CLI, later optionally MCP |

I would not force Shopify's no-shared-code philosophy onto Expo. That decision was made specifically for its move to two independent native codebases.

For Expo, shared TypeScript is an advantage. The useful part of Reflex is the strict, externally observable state-and-action contract, not the duplication of implementation.

There are also things the headless system cannot verify: native navigation gestures, layout, accessibility, animation, camera behavior, and actual platform integration. I would retain a smaller set of Maestro or Detox end-to-end tests, along with visual verification, for those concerns.

## 12. An additional opportunity: MCP support

Once the CLI protocol exists, exposing it through an MCP server would be relatively straightforward.

A coding agent could have tools such as:

    expo_reflex.inspect()
    expo_reflex.dispatch(action, input)
    expo_reflex.navigate(route)
    expo_reflex.load_fixture(name)
    expo_reflex.run_journey(name)

Those tools would use the same underlying session and introspection system as the CLI. They should not create a separate application-control API.

This could make an Expo app substantially easier for agents to understand and modify because the agent could directly inspect application behavior rather than infer everything from screenshots and source code.

### Final recommendation

I would build a small, Expo-native Reflex implementation rather than adopt a large state-management or testing framework solely to reproduce this architecture.

The minimum useful system is surprisingly small: a pure TypeScript core, a standard ViewModel contract, an introspection layer, a headless process, and a CLI.

The hardest part is not the CLI. It's deciding who owns navigation and ensuring that every user-visible state transition and action is represented in the core.

One question would materially change how I'd design the implementation:

Are you implementing this in an existing Expo app or designing a new app around Reflex?

Existing Expo app with Expo Router and current state management

New Expo app — architecture can be designed around Reflex from the beginning

Reusable Reflex-style toolkit for multiple Expo apps

Develop the implementation plan

---

# Prior art: A protocol and runtime for observable, controllable application state

The most promising direction is to treat this as a general-purpose application control plane, not a new state-management library.

The fundamental abstraction is:

> An application exposes a discoverable graph of stateful objects. External clients can inspect those objects, discover supported actions, execute actions, observe resulting state transitions, and run deterministic scenarios.

There is substantial prior art. The interesting pieces are distributed across debugging protocols, actor systems, state-machine runtimes, UI automation, developer tools, and agent protocols.

I would evaluate the existing approaches against six requirements:

1.  Observability: Read current application state without rendering the UI.
2.  Controllability: Invoke semantically meaningful actions, not simulated button presses.
3.  Discoverability: Enumerate objects, actions, arguments, and schemas.
4.  Subscriptions: Observe changes and asynchronous operations.
5.  Headless execution: Run application behavior without a browser or native renderer.
6.  Transport independence: Use the same protocol from a CLI, test runner, IDE, or AI agent.

The key question is whether an existing standard already solves enough of this problem that we should extend it rather than invent another protocol.

## 1. Prior-art landscape

The closest precedents aren't necessarily the ones that advertise themselves as agent frameworks.

[Introducing Stately Inspector \| Stately](https://images.openai.com/static-rsc-4/4s4eWLNOpKdNMA8z3aXw6eFvASDSGZbIUgfXar6QjRzUZU2O2Z2cSUnUzgimKsqvLwBW5zeMrykn_dg3L8KPmKrGq_Mf7K0oWs4rNoZd0jYbsS9uuFVDSnYnAnJzrNowN_EV5UL6q3V8scv9Ix3nGWY3r2HkA9NtZgqpOaSkVRs?purpose=inline)

XState / Stately Inspector

Closest runtime model

Actors have identities, snapshots, events, lifecycle, and subscriptions. The inspector can observe an entire actor system, including child actors and transitions.

Borrow: Actor graph, event model, snapshot lifecycle.

[How to Set Up Reactotron to Debug AsyncStorage in React Native - DEV Community](https://images.openai.com/static-rsc-4/LT0G3pZZA-t1JUEKcUcKgW4ng-bLfZYb_L5lq6a-WRUMif12m7Jcoh6oyrBc144MhGGCR1O-p_2LOuQ9EixkKIJfRU_szpDcYZINhuVE_brsX6Ya_6sbR4tOHyJ4c7FTUFg_El6cl2qorUkXePCZT5ifpTW61tBPJigfja1W2go?purpose=inline)

Reactotron

Closest React Native precedent

Reactotron already supports inspecting application state, dispatching actions, subscribing to state, and replacing state through supported integrations.

Borrow: React Native connectivity, plugins, remote debugging experience.

[Redux Essentials, Part 2: Redux Toolkit App Structure \| Redux](https://images.openai.com/static-rsc-4/QF5Djm3FJzCZllBLxB-1BbLdNnlyM5GU3dHyjQA_QC5ycz2451sIBTQHvTFOGEHUi5MRw2McMOSUQ7V957P_EDfhTLbGNUJu7hXUzO4sjUaDR4MVu4ysD-PwD8gOcoxDhySg56pbFcu0Kk_Oj9oX3ylubJL2UlY4vOnoMMIQJNI?purpose=inline)

Redux DevTools

Closest state debugging precedent

Remote monitoring, action dispatch, state snapshots, replay, and time travel are established capabilities. Its integrations extend beyond Redux itself.

Borrow: Action timeline, replay, state-diff inspection.

DevTools Protocol

Chrome DevTools Protocol

Closest remote object protocol

CDP exposes remote object identities, property inspection, function invocation, and runtime events.

DevTools Protocol

Borrow: Object handles, domain-oriented methods, lifecycle management.

Dart VM Service

Dart VM Service Protocol

Closest transport and subscription precedent

A versioned JSON-RPC protocol over WebSocket, with remote object identifiers and named event streams.

Borrow: RPC conventions, stream subscriptions, versioning, stale-handle semantics.

MCP / Playwright

Model Context Protocol + Playwright MCP

Closest agent interaction precedent

MCP provides tool discovery and invocation schemas. Playwright MCP exposes a structured accessibility tree with references that agents can act on.

Borrow: Discoverable capabilities, agent-friendly observations, observe–act–verify loops.

### Capability comparison

Assessment of the cited implementations. ✓ = built-in or established capability; ◐ = partial, adapter-dependent, or different semantics; — = not a primary capability.

|  |  |  |  |  |  |
|----|----|----|----|----|----|
| System | Inspect | Invoke | Discover actions | Observe changes | Headless |
| XState | ✓ | ✓ | ◐ | ✓ | ✓ |
| Reactotron | ✓ | ✓ | ◐ | ✓ | — |
| Redux DevTools | ✓ | ✓ | ◐ | ✓ | ◐ |
| Chrome DevTools Protocol | ✓ | ✓ | ◐ | ✓ | ◐ |
| Dart VM Service | ✓ | ✓ | ◐ | ✓ | ✓ |
| MCP | ◐ | ✓ | ✓ | ◐ | ◐ |
| Playwright MCP | ✓ | ✓ | ✓ | ◐ | ◐ |

The critical gap is that none of these, by itself, provides a framework-independent contract for both semantic application actions and deterministic headless user journeys.

XState comes closest to the runtime model. MCP comes closest to the external agent interface. Reactotron comes closest to the Expo development experience.

## 2. The deeper lessons

### A. XState: model application state as actors

XState's most useful abstraction is not its statechart syntax. It's the actor contract:

- An actor has a stable identity while alive.
- It accepts events.
- It produces snapshots.
- It can be subscribed to.
- It has a lifecycle.
- It can create or invoke other actors.

This maps remarkably well to Shopify's screen ViewModels.

An inventory screen can be one actor; an authentication session another; navigation can be an actor managing active screens.

The difference is that XState's inspection API is primarily observational. Its documentation explicitly separates observing an actor from sending events to it.

For the proposed library, I would preserve that distinction. The inspector observes; a separate authorized dispatcher invokes actions.

That is cleaner than having one object expose arbitrary mutable state.

### B. Redux DevTools: actions are better than state mutation

Redux DevTools proves the value of treating state transitions as first-class debugging information.

A protocol that merely supports:

    setState("cart.quantity", 12)

would be too weak.

It bypasses validation, business rules, and side effects.

A better protocol exposes:

    dispatch("Cart", "SetQuantity", {"quantity":12})

The action passes through the same application logic as a real user interaction.

This also makes test failures easier to explain: you know which action produced which state transition.

Redux DevTools' remote protocol is worth studying, but I would not adopt it as the primary wire format. Its monitor commands, serialized actions, and state-replacement behavior are oriented around debugging stores rather than discovering typed business capabilities.

### C. CDP and Dart: don't transmit live JavaScript objects

A protocol should never depend on sending a raw object reference across process boundaries.

Chrome DevTools and Dart VM Service solve this with remote object identifiers.

For an application-level protocol, I'd use semantic handles:

    app://session/current
    app://navigation/root
    app://screen/inventory-detail/instance-42
    app://service/cart

A client can inspect an object through its handle without needing its in-memory representation.

Unlike a VM debugger, though, I would expose only explicitly registered application objects.

That makes the interface more stable, safer, and easier for agents to understand.

### D. Playwright MCP: optimize observations for agents

Playwright's accessibility snapshots are an especially important precedent.

Instead of forcing an agent to interpret screenshots, it provides a structured representation of interactive elements and stable-enough references for the current observation.

I'd apply that idea to application state.

An agent doesn't need every property in a Redux store. It needs to know:

- Which screen is active?
- What meaningful state is visible?
- What actions are available?
- What inputs do those actions require?
- What changed after an action?

This suggests a compact, semantic application snapshot rather than a raw state dump.

## 3. Proposed protocol: an application control protocol

Based on the prior art, I would define a small protocol with six operations.

|                 |                                     |                 |
|-----------------|-------------------------------------|-----------------|
| Operation       | Purpose                             | Precedent       |
| `app.describe`  | Discover runtime capabilities       | MCP             |
| `app.inspect`   | Read the focused node or tree       | CDP, Playwright |
| `app.dispatch`  | Invoke a typed semantic action      | XState, Redux   |
| `app.subscribe` | Observe state and lifecycle changes | XState, Dart VM |
| `app.wait`      | Wait for a predicate or transition  | Playwright      |
| `app.reset`     | Reconstruct an app from fixtures    | Shopify Reflex  |

These would be application-level methods carried over JSON-RPC 2.0, which already standardizes request IDs, responses, errors, and notifications without binding the protocol to a particular transport.

### Example: inspection response

    {
      "protocolVersion": "0.1",
      "sessionId": "session-123",
      "revision": 42,
      "focus": "screen/inventory-detail/42",
      "node": {
        "id": "screen/inventory-detail/42",
        "type": "screen",
        "name": "InventoryDetail",
        "state": {
          "productId": "123",
          "quantity": 5,
          "saving": false
        },
        "actions": {
          "SetQuantity": {
            "inputSchema": {
              "type": "object",
              "properties": {
                "quantity": {
                  "type": "integer",
                  "minimum": 0
                }
              },
              "required": ["quantity"],
              "additionalProperties": false
            }
          },
          "Save": {
            "inputSchema": {
              "type": "object",
              "additionalProperties": false
            }
          }
        }
      }
    }

This is an illustrative response payload, not an existing standard.

Notice that the protocol exposes only explicitly registered state and actions. There is no arbitrary `eval`, no raw function invocation, and no ability to mutate internal state directly.

### Example: action dispatch

    {
      "jsonrpc": "2.0",
      "id": 17,
      "method": "app.dispatch",
      "params": {
        "sessionId": "session-123",
        "nodeId": "screen/inventory-detail/42",
        "action": "SetQuantity",
        "input": {
          "quantity": 12
        },
        "expectedRevision": 42
      }
    }

The runtime should validate the schema, check that the node is still active and that the action is permitted, invoke the registered handler, and return an operation result.

`expectedRevision` is particularly valuable: it prevents an agent from acting on a stale observation without realizing the application has changed.

I would distinguish action accepted from effect completed. A save action might start a network request and return before it finishes. The client should subsequently observe or wait for the desired state, rather than assuming a successful dispatch means the business operation succeeded.

### Example: state subscriptions

    {
      "jsonrpc": "2.0",
      "method": "app.event",
      "params": {
        "sessionId": "session-123",
        "sequence": 43,
        "type": "state.changed",
        "nodeId": "screen/inventory-detail/42",
        "revision": 43,
        "state": {
          "productId": "123",
          "quantity": 12,
          "saving": false
        }
      }
    }

For the first version, I would transmit complete, small snapshots rather than JSON Patch operations. Diffs can be added later when bandwidth or performance warrants them.

A production-quality protocol would also need snapshot size limits, resynchronization after dropped events, subscription cleanup, and explicit lifecycle events when nodes disappear.

## 4. The runtime should be smaller than the protocol

This is where I'd make a strong distinction between the reusable library and the application's architecture.

The runtime needs only a few primitives:

    interface ObservableNode<State, Action> {
      id: string;
      name: string;

      snapshot(): Readonly<State>;

      subscribe(
        listener: (state: Readonly<State>) => void
      ): () => void;

      dispatch(action: Action): Promise<void> | void;
    }

    interface IntrospectionAdapter {
      describe(): NodeDescriptor;
      snapshot(): unknown;
      invoke(action: string, input: unknown): Promise<void>;
      subscribe(listener: () => void): () => void;
    }

    interface ApplicationRuntime {
      register(node: IntrospectionAdapter): () => void;
      inspect(nodeId: string): NodeSnapshot;
      dispatch(command: DispatchCommand): Promise<DispatchResult>;
      subscribe(listener: (event: RuntimeEvent) => void): () => void;
    }

These are conceptual interfaces; the concrete types and schema-validation boundaries would need to be specified.

The runtime does not need to know whether the underlying application uses XState, Zustand, Redux, or custom ViewModels.

That separation allows adapters to translate existing application abstractions into the protocol.

The adapters are intentionally explicit. Automatically exporting every store field or method would create unstable APIs and potentially expose sensitive state.

## 5. Should we use MCP as the actual protocol?

I would use MCP as an external interface, not as the internal runtime contract.

MCP already solves an important problem: allowing agents to discover named tools, understand their JSON schemas, and invoke them.

But application introspection has requirements that go beyond ordinary tool calls: state revisions, node lifecycle, event ordering, test fixture resets, and deterministic state transitions.

Those semantics should be defined independently of whichever agent protocol happens to be popular.

A thin MCP adapter could expose a handful of tools:

    app_inspect
    app_dispatch
    app_wait
    app_reset

I would not necessarily create one MCP tool per application action. A generic dispatch tool plus a discoverable schema-bearing application tree scales better when actions change dynamically.

For frequently used actions, an MCP adapter could optionally generate individual tools.

That gives you a durable core protocol, with MCP providing agent compatibility.

## 6. An important counterargument from Shopify

Shopify explicitly argues against publishing Reflex as a reusable library.

Their reasoning is that the introspection system is closely coupled to their navigation model, session management, and fixture conventions. They believe the architecture is more transferable than the implementation.

I think that argument is partly correct.

There are two different things we could try to standardize:

|                                 |                        |
|---------------------------------|------------------------|
| Layer                           | Should it be reusable? |
| Wire protocol                   | Yes                    |
| Node and action schemas         | Yes                    |
| Runtime registry and dispatcher | Yes                    |
| Transport adapters              | Yes                    |
| CLI and agent integration       | Yes                    |
| Test session lifecycle          | Yes                    |
| Application navigation model    | Optional               |
| ViewModel architecture          | No                     |
| Business logic and fixtures     | App-specific           |

The reusable boundary should be the introspection and control plane, not the entire Reflex application architecture.

That also resolves the tension between existing-app adoption and Shopify-style headless testing.

An existing Expo application can expose observable state through adapters. An application designed for headless execution can go further by keeping its core platform-independent.

The protocol supports both, but the library shouldn't pretend that they provide equivalent testing guarantees.

## 7. Recommended design decisions

Runtime model

Actor-inspired, but not dependent on XState

Wire format

Versioned JSON-RPC 2.0

State representation

Explicit JSON snapshots with revisions

Action model

Named, schema-validated semantic commands

Subscriptions

Ordered events with snapshot resynchronization

Agent integration

MCP adapter

Expo integration

React Native development bridge

Headless execution

Optional host with injected services

Testing

Journey SDK over the same protocol

For a first implementation, I would prioritize four capabilities: register a node, inspect its state, dispatch a typed action, and subscribe to changes.

I would explicitly defer time travel, arbitrary state mutation, sophisticated graph queries, distributed sessions, and a visual inspector. Those features would substantially expand the design surface before the fundamental contract has been validated.

Security should be part of the initial design, though: explicit action allowlists, sensitive-field redaction, authenticated local connections, and no unrestricted remote evaluation.

## 8. Research conclusion

The most valuable prior art to study in implementation detail is:

1.  [XState Inspection API](https://stately.ai/docs/inspection?utm_source=chatgpt.com) — for the observable actor model and transition events.
2.  [Reactotron](https://github.com/infinitered/reactotron?utm_source=chatgpt.com) — for real-world React Native integration and remote state control.
3.  [Redux DevTools](https://github.com/reduxjs/redux-devtools?utm_source=chatgpt.com) — for action history, remote dispatch, and state replay.
4.  [Dart VM Service Protocol](https://github.com/dart-lang/sdk/blob/main/runtime/vm/service/service.md?utm_source=chatgpt.com) — for versioned RPC, object identity, and event streams.
5.  [Playwright MCP snapshots](https://playwright.dev/mcp/snapshots?utm_source=chatgpt.com) — for agent-friendly inspection and interaction.
6.  [Shopify Reflex](https://shopify.engineering/reflex?utm_source=chatgpt.com) — for the strict boundary between UI, application behavior, and headless testing.

I did not find a mature, widely adopted solution in this research that combines all six requirements into a framework-independent application protocol. That is a meaningful opportunity, although not proof that no such project exists.

### The thesis I would pursue

Build a small protocol and runtime that makes application behavior inspectable and executable independently of its user interface.

Not a new state manager. Not a new UI automation framework. Not an agent framework.

A shared control plane for application behavior.

Its defining API would be:

    const app = createRuntime();

    app.register(cartNode);

    app.inspect("cart");
    app.dispatch("cart", "AddItem", { productId: "123" });
    app.subscribe("cart", onChange);

Everything else—Expo, headless testing, MCP, CLI, visual debugging—would be an adapter or consumer of that contract.

The next engineering step I'd recommend is a protocol-first proof of concept: implement the same four operations against two fundamentally different backends, such as Zustand and XState, then exercise both through one CLI and one test suite.

If that works without special-casing either backend, we'd have evidence that the abstraction is genuinely reusable rather than simply a Shopify Reflex implementation repackaged for Expo.

---

# Effect v4 as the foundation for an application control protocol

Effect could materially improve the Reflex-inspired architecture we've been developing, especially in five areas: schema definitions, typed actions, dependency injection, concurrency, and deterministic testing.

The biggest opportunity is to make an application's introspection contract an executable specification rather than a separate description of the application.

Instead of maintaining a ViewModel, a Zod action schema, a dispatcher, and a testing interface independently, we could define a capability once and derive much of the infrastructure from it.

I'd investigate Effect v4 as a foundation for three layers:

- Protocol: What state and actions an application exposes.
- Runtime: How actions execute, how dependencies are supplied, and how state changes are observed.
- Testing: How application behavior runs deterministically without Expo or a simulator.

An important design constraint: the public protocol should remain ordinary JSON and JSON Schema. Clients should not need to use Effect, even if the server implementation does.

## 1. Effect v4 Schema is a particularly strong fit

The current Effect v4 documentation describes Schema as more than a validator. A single schema can be interpreted to produce decoders, encoders, JSON Schema, Standard Schema V1, equivalence checks, formatting, and arbitrary test-data generators.

That maps almost perfectly onto the needs of an application introspection protocol.

### Example: a single schema for an application action

    import { Schema } from "effect";

    export const SetQuantity = Schema.Struct({
      productId: Schema.String,
      quantity: Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(0)
      ),
    }).annotate({
      identifier: "SetQuantity",
      title: "Set inventory quantity",
      description: "Updates the quantity of a product",
    });

    // Generate a JSON Schema document for external clients.
    export const SetQuantityJsonSchema =
      Schema.toJsonSchemaDocument(SetQuantity, {
        onExcessProperty: "error",
      });

This gives us a typed internal definition and a portable external contract.

The generated JSON Schema could power CLI help, MCP tool input definitions, editor forms, documentation, and protocol validation.

Effect v4 also supports custom annotations and controlled export of metadata into JSON Schema.

For example, we could introduce metadata such as `x-reflex-confirmation`, `x-reflex-category`, or `x-reflex-idempotent`.

I would be careful to distinguish metadata from enforcement. Marking an action as requiring confirmation is useful for tooling, but the runtime must still enforce authorization and safety rules.

### One important v4 detail: decoded versus encoded types

Effect v4 Schema explicitly distinguishes the decoded Type from its Encoded representation.

This is valuable because the internal application might use richer domain values than JSON can represent.

For example, an application may use a domain-specific product identifier or date representation, while external clients communicate with strings.

The protocol should always publish the encoded wire representation, not the internal TypeScript representation.

That also means we should test encoding and decoding in both directions, and not assume all custom refinements can be represented exactly by JSON Schema.

## 2. Effect's other primitives could eliminate much of our custom runtime

Effect + typed errors

Application actions become typed computations with explicit success, failure, and dependency requirements.

This is stronger than an arbitrary `Promise<void>` because expected business failures can be distinguished from unexpected defects.

High value

Context / Service / Layer

API clients, authentication, storage, navigation, clock, and fixtures can be supplied as dependencies.

The same application logic runs with native adapters in Expo and deterministic adapters in Node.

High value

Ref + Stream / PubSub

Mutable runtime state can be observed as a stream of changes. The protocol adapter translates those changes into subscriptions and revisioned snapshots.

We still need to define event ordering, retention, and resynchronization ourselves.

High value

Fiber + Scope

Long-running actions can be supervised and interrupted. When a screen or application session closes, its associated effects can be cleaned up.

This is particularly useful for live Expo sessions and tests that would otherwise leak subscriptions or pending operations.

High value

Clock + deterministic testing

Timeouts, retries, and delayed state transitions can use injected clock behavior.

This reduces the need for real sleeps in headless journey tests.

High value

Effect RPC

Effect v4 has a schema-first, transport-agnostic RPC system with typed contracts and pluggable serialization. This could replace a substantial amount of hand-written transport infrastructure.

Its v4 RPC APIs are marked unstable, so I'd evaluate them before making them the public protocol.

Evaluate

### The biggest improvement is structured concurrency

Consider an inventory screen that starts saving, then the user navigates away.

With a conventional Promise-based implementation, we must manually decide what happens to the pending request, whether it can update state after unmounting, and how cleanup occurs.

Effect provides a coherent lifecycle model: the action can run in a supervised fiber, and its scope can be tied to the screen or application session.

That doesn't automatically solve every race condition, but it gives us better primitives for doing so.

For an introspection protocol, it also suggests a richer action lifecycle:

The protocol could return an operation ID immediately and allow the client to inspect, await, or cancel that operation.

That would be much more reliable for agents than treating every command as a single opaque asynchronous call.

## 3. Effect v4 RPC changes the protocol decision

This is one of the more significant findings.

Effect v4's RPC serialization supports JSON-RPC 2.0 and newline-delimited JSON-RPC, in addition to other serialization formats. The documented APIs include `layerJsonRpc`, `layerNdJsonRpc`, and corresponding serializers.

That means we might not need to implement our own JSON-RPC framing, parsing, and typed client machinery.

I would evaluate two architectures:

Option A — Effect RPC as the protocol implementation

Define the control methods as Effect RPC procedures. Derive clients and server handlers from the contracts.

This minimizes infrastructure code but introduces coupling to Effect's evolving RPC implementation.

Option B — Independent protocol, Effect-powered implementation

Define stable JSON-RPC method names, request schemas, response schemas, and event semantics. Implement them using Effect internally, optionally using its RPC machinery where compatible.

This requires more integration code but makes independent clients and long-term protocol stability easier.

I prefer Option B for a reusable public library, particularly because Effect v4's RPC APIs are currently documented as unstable.

However, I'd build an Option A prototype first to discover how much infrastructure Effect can provide.

One useful detail: the JSON-RPC serializer can be configured with `controlMessages: false` for ordinary JSON-RPC peers. That's worth testing against a plain JavaScript client, rather than assuming that using a JSON-RPC serializer automatically guarantees compatibility with every external client.

## 4. Schema-derived property-based testing is a major opportunity

Effect v4 includes a native Arbitrary module that can generate values from schemas, shrink failing cases, and reproduce runs using seeds. The API is marked unstable, but its capabilities are highly relevant.

For our application protocol, this means every declared action schema could potentially become a source of generated tests.

For example, an inventory action might accept any nonnegative integer quantity.

We could generate hundreds of valid quantities and verify invariants:

    import { Arbitrary, Effect, Schema } from "effect";

    const Quantity = Schema.Int.check(
      Schema.isBetween({
        minimum: 0,
        maximum: 1000,
      })
    );

    const program = Arbitrary.checkEffect(
      Arbitrary.schema(Quantity),
      (quantity) =>
        Effect.sync(() => {
          // Example invariant for a quantity domain.
          return quantity >= 0 && Number.isInteger(quantity);
        }),
      {
        runs: 100,
        seed: 42,
      }
    );

    const result = await Effect.runPromise(program);

This example validates a simple property. The more valuable version would instantiate the headless app, dispatch `SetQuantity`, and verify the resulting state and persistence behavior.

There are two especially interesting testing applications:

Schema conformance testing: Generate inputs and verify that action handlers honor their declared contracts.

State-machine testing: Generate sequences of actions and verify invariants across the resulting states.

The second is more powerful, but it requires state-aware generation. A schema alone cannot know that `Save` is unavailable before a product has loaded, or that `GoBack` is invalid at the navigation root.

I'd represent these constraints as explicit action availability and state preconditions rather than trying to infer them from JSON Schema.

## 5. Deterministic headless testing becomes much cleaner

Effect v4's `TestClock` lets tests advance logical time without waiting for real time. Its documentation demonstrates advancing time to trigger sleeps, timeouts, and recurring operations.

This could support a testing interface such as:

    await app.dispatch("Inventory", "Save");
    await app.advanceTime("5 seconds");
    await app.waitFor("Inventory", {
      saving: false,
    });

The test SDK would translate these operations into the underlying Effect runtime.

We could also inject different service layers:

    Application logic
           |
           v
    Service requirements
           |
           +-- ExpoLive
           |    API / SecureStore / Device
           |
           +-- HeadlessTest
           |    Fixture API / Memory storage / TestClock
           |
           +-- FailureScenario
                API timeout / Expired auth / Offline mode

Effect Layers are specifically designed to construct and manage service dependency graphs, making them a natural fit for these environments.

An important limitation is that virtual time only controls operations using the injected clock. Native timers, third-party SDKs, network calls, and arbitrary JavaScript scheduling do not automatically become deterministic.

For a fully headless app, I'd enforce a rule that testable core logic uses Effect-managed services for time and external I/O.

## 6. Proposed Effect-native developer API

I would experiment with an API where the developer defines state and actions using Effect Schema, then supplies handlers using Effect.

Something like:

    import { Effect, Schema } from "effect";
    import { defineCapability } from "@reflex/effect";

    // Proposed API, not an existing package.
    export const Inventory = defineCapability({
      name: "Inventory",

      state: Schema.Struct({
        productId: Schema.String,
        quantity: Schema.Int,
        saving: Schema.Boolean,
      }),

      actions: {
        SetQuantity: {
          input: Schema.Struct({
            quantity: Schema.Int.check(
              Schema.isGreaterThanOrEqualTo(0)
            ),
          }),

          handler: ({ quantity }, context) =>
            Effect.sync(() => {
              context.update((state) => ({
                ...state,
                quantity,
              }));
            }),
        },

        Save: {
          input: Schema.Struct({}),

          handler: (_, context) =>
            context.services.inventory.save(
              context.state.productId,
              context.state.quantity
            ),
        },
      },
    });

This is a conceptual API sketch. `defineCapability`, `context.update`, and `context.services` are abstractions we'd implement; they are not Effect v4 APIs.

I would prefer a final design that uses Effect's native service requirements rather than a custom `context.services` bag. That would preserve type-level dependency tracking.

The ideal library would derive the following from this one definition:

|                       |                     |
|-----------------------|---------------------|
| Derived artifact      | Source              |
| Runtime validation    | Input schemas       |
| Action metadata       | Schema annotations  |
| CLI commands          | Capability registry |
| MCP tool descriptions | JSON Schema         |
| Typed action client   | Capability types    |
| Test input generators | Arbitrary           |
| Error serialization   | Typed error schemas |
| Documentation         | Schema descriptions |

This reduces duplication while preserving a single source of truth.

## 7. Should Effect be a required dependency?

This is the most consequential product decision.

My preferred package architecture would be:

    packages/
      protocol/
        # JSON-compatible contracts and types

      runtime/
        # Node registry, sessions, revisions,
        # authorization, subscriptions

      effect/
        # Effect Schema + Effect action adapters
        # Layer, Scope, Fiber integration

      expo/
        # React Native / Expo integration

      rpc/
        # JSON-RPC transport

      cli/
        # Terminal client

      mcp/
        # Agent tools

      test/
        # Journey testing and fixtures

The core protocol would be independent of Effect.

The `effect` package would be a first-class integration, potentially the most capable implementation, but not a requirement for every consumer.

Why? Because requiring developers to adopt Effect throughout their application would substantially reduce adoption among existing Expo apps using Zustand, Redux, TanStack Query, or custom hooks.

Effect v4's `Schema.toStandardSchemaV1` also makes interoperability easier, although it requires schemas that don't depend on decoding services.

That gives us a useful compatibility strategy: support Effect Schema natively while allowing other Standard Schema-compatible validators through adapters.

## 8. Risks and tradeoffs

|  |  |  |
|----|----|----|
| Risk | Why it matters | Mitigation |
| v4 API changes | RPC and Arbitrary are marked unstable | Isolate behind internal adapters |
| Runtime size | Effect may increase Expo bundle size | Benchmark Metro/Hermes bundles |
| Learning curve | Developers may not know Effect | Offer Promise/Zustand adapters |
| Schema mismatch | JSON Schema cannot express all refinements | Server remains validation authority |
| Concurrency | Actions can race and overwrite state | Define per-node dispatch semantics |
| State exposure | Introspection can leak secrets | Explicit projections and redaction |
| Headless assumptions | Native dependencies may escape the core | Dependency boundaries and import checks |

One additional concern is runtime ownership. We should not create a new Effect runtime for every action.

Instead, each application session should own a long-lived runtime and scope, with explicit disposal when the session ends. Action fibers should be supervised within that session.

For Expo, I would benchmark development reloads, runtime cleanup, and Hermes compatibility before committing to this architecture.

## 9. What I would prototype next

I'd build a small proof of concept comparing an Effect-native implementation with a conventional implementation.

### Effect v4 feasibility experiment

Implementation checklist

0 / 9

Define state and actions with Effect Schema

Export JSON Schema and validate wire inputs

Implement state inspection and subscriptions

Run typed Effect actions with injected services

Run the same feature in Node and Expo

Test virtual time and service failures

Generate property-based action tests

Expose actions through plain JSON-RPC

Measure Hermes compatibility and bundle size

Develop this proof of concept

### Conclusion

Effect v4 makes the proposed library more compelling, especially if we use its strengths without making Effect itself the protocol.

My preferred architecture is:

Effect Schema defines capabilities → Effect runs behavior → a framework-independent protocol exposes the results → CLI, MCP, Expo, and tests consume that protocol.

I would adopt Effect Schema, service Layers, structured concurrency, and deterministic testing as first-class implementation tools.

I would keep the wire protocol independent, treat Effect RPC as an implementation option, and make Effect optional for applications that already have a different state architecture.

## Primary sources

- [Effect v4 Schema introduction](https://effect.website/docs/v4/schema/introduction?utm_source=chatgpt.com)
- [Effect v4 JSON Schema generation](https://effect.website/docs/v4/schema/json-schema?utm_source=chatgpt.com)
- [Effect v4 Arbitrary and property-based testing](https://effect.website/docs/v4/schema/arbitrary?utm_source=chatgpt.com)
- [Effect v4 Layers](https://effect.website/docs/v4/requirements-management/layers?utm_source=chatgpt.com)
- [Effect v4 TestClock](https://effect.website/docs/v4/testing/testclock?utm_source=chatgpt.com)
- [Effect v4 RPC serialization reference](https://effect.website/docs/v4/api/effect/rpc/RpcSerialization?utm_source=chatgpt.com)

The highest-value experiment is to determine whether an Effect Schema capability definition can generate both an agent-facing JSON contract and a deterministic headless test harness without requiring the Expo application to adopt a particular state manager. If it can, that's a strong foundation for a genuinely reusable library.
