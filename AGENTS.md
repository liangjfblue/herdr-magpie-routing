# Herdr Magpie Routing

This repository is an installable Herdr mod. The user asked an agent to add a small live Routing panel to an existing Herdr setup. The agent MUST read this file before changing the user's files.

## Goal

Install the `routing` mod so Herdr shows Magpie's live gateway trace in a floating panel. The panel shows:

- the requesting Agent on the left;
- Magpie in the middle;
- the selected provider/model on the right;
- a bee carrying a petal from Agent to provider;
- the same petal held at the provider while it generates;
- a return bee carrying that petal back to the Agent when the route finishes;
- the route status, retry state, timing, session and error on hover.

The mod reads Magpie's trace; it does not route requests or change Magpie configuration.

## Required safety rules

1. Inspect the user's Herdr root, current layout and existing `mods/` before copying anything.
2. Never overwrite an existing mod, layout, asset or user setting. If `mods/routing` already exists, ask the user whether to merge, replace, or install under a new name and update every asset path consistently.
3. Preserve the user's current layout. Prefer adding the panel as a floating block and adding one button to the user's existing tab/header mod. Do not replace `layouts/main*.json` wholesale.
4. Keep a backup or use Git before editing an existing layout or mod. A clean rollback is REQUIRED.
5. Do not copy the repository's tests, docs or `.git` directory into the user's Herdr directory unless requested.
6. Do not expose credentials or commit Herdr runtime data, session data, screenshots containing private content, `shared.json`, `view.json`, `data/`, telemetry, sockets or generated `.d.ts` files.
7. Tell the user that this mod executes `curl` through Herdr's `exec` API and reads the local Magpie trace endpoint. It is trusted code and has network/process access by design.
8. The flower, bee carrier and center icon are included visual assets. The user supplied the flower and center bee icon and confirmed that the GPT-generated artwork may be used in this project. Keep that provenance note when redistributing the repository.

## Prerequisites

- Herdr app with GPUI mod support and `herdr-app check`.
- A running Magpie gateway on `http://127.0.0.1:3425`.
- `curl` available on the machine running Magpie. For a remote Herdr space, the command runs on that space's machine through Herdr.
- The user understands that the trace contains route metadata such as Agent, model, provider, session and errors, but not the prompt body.

## Install procedure

### 1. Identify paths

Use the user's actual Herdr root. Normally it is `~/.config/herdr-app` on Unix-like systems and `C:\Users\<user>\.config\herdr-app` on Windows. Confirm it from the running Herdr setup instead of guessing.

Record:

- the active layout file;
- the active tabs/header mod, if it is a custom mod;
- whether `mods/routing` or an equivalent name already exists;
- whether the layout already contains a floating block.

### 2. Copy only the mod

Copy these files into the user's Herdr root, preserving this exact structure:

```text
mods/routing/main.js
mods/routing/mod.json
mods/routing/flower.png
mods/routing/magpie.png
mods/routing/bee-out.png
mods/routing/bee-back.png
```

The source uses asset paths such as `mods/routing/bee-out.png` and `mods/routing/flower.png`; moving the files to another folder without changing every reference breaks the mod.

### 3. Add the floating panel

Add this block to the user's existing work-area row, without removing other children:

```json
"floating": [
  {
    "id": "routing",
    "content": { "mod": "routing" },
    "edge": "right",
    "align": "start"
  }
]
```

If the work-area already has a `floating` array, append this object. If the layout uses a different row, place it on the row that contains the active terminal pane. Keep the user's existing floating blocks and IDs.

### 4. Add the toggle button

If the user's tabs/header mod already has a Files/Changes action row, add a Routing button beside them. The button must toggle shared state, not open a second page:

```js
const on = shared("routing.open") === true;
return h_flex().id("tab-routing").child("Routing").on_click(() => {
  setShared("routing.open", !on);
});
```

Use the user's existing button styling, icon convention and event-propagation guard. The complete behavior is:

```js
const on = shared("routing.open") === true;
button
  .on_click((_event, cx) => {
    cx.stop_propagation();
    setShared("routing.open", !on);
  });
```

Do not add a second tab or route page unless the user explicitly asks for one.

### 5. Validate before declaring success

Run:

```sh
herdr-app check <herdr-root>/mods/routing
node --test <this-repository>/tests/routing-flight.test.cjs <this-repository>/tests/routing-lifecycle.test.cjs
```

For parity tests, set `MAGPIE_ROOT` to a local Magpie checkout and run:

```sh
node --test <this-repository>/tests/routing-magpie-parity.test.cjs
```

Then exercise the real UI:

1. click Routing beside Files/Changes;
2. confirm the panel appears at the upper-right;
3. send one Magpie request;
4. confirm the bee carries the petal Agent → Magpie → provider;
5. confirm the petal remains at provider while the reply is generated;
6. confirm the return bee carries the same petal provider → Magpie → Agent;
7. confirm no packet remains after the return;
8. turn Routing off and confirm the panel and flights disappear;
9. restart or reload Herdr and confirm the user's original layout still works.

A screenshot is useful, but it does not replace `herdr-app check` and the lifecycle tests.

## Rollback

Rollback MUST restore the user's prior layout and mod files. Remove only files installed by this integration, remove the `routing` floating block, remove the Routing button, and leave the user's runtime files untouched. If Git was used, show the user the diff and revert only the integration commit.

## Known behavior and limits

- The panel polls the local trace with a long-poll request and refreshes at roughly 650 ms intervals.
- It can read traces from machines represented by Herdr spaces; remote execution depends on the user's Herdr machine configuration.
- It shows at most four source lanes by default and can expand the stage.
- Completed route cards linger for 12 seconds, matching Magpie's Routing page; the packet itself is cleaned up after returning.
- A failed or unavailable gateway is shown as disconnected/stale and the last bounded snapshot is retained briefly.
- The default endpoint is hard-coded as `http://127.0.0.1:3425/v1/magpie/trace`. Changing it requires a code change and a matching validation run.
