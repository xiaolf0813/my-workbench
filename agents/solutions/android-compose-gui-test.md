# Android Compose — GUI-test instrumentation & locating recipe

How to instrument a Jetpack Compose app so the gui-test toolkit can locate
controls, and how to resolve them at test time — plus the Android platform
spec (tree acquisition, action channel) a Compose app needs. Division of
labor: the instrumentation and the registry are built as implementation work;
test-time resolution and driving consume them. Complements the project's
`gui-test/README.md` and `toolkit-gui-test.md`; where this file is more
specific, it wins. Two
execution modes: **live** (resolve and act through the tree — the backends
below) and **scripted** (instrumentation tests — deterministic,
fast, the regression layer; see the instrumentation section).

## Live tree acquisition — in this order

1. **In-app semantics dump hook** (debug build) — the app walks its own
   semantics tree on a broadcast/deep-link trigger and writes JSON (tag, text,
   contentDescription, role, enabled, boundsInWindow) for every window,
   dialogs included. Milliseconds per call, never stale, and it reads
   `SemanticsProperties.TestTag` directly — the bridge flag in step 4 is not
   required on this path.
2. **`adb shell uiautomator dump`** — zero-intrusion fallback when the
   hook is unavailable. Identity surfaces as `resource-id` (Views
   always; Compose testTag needs the bridge flag from step 4). May return a
   stale or empty tree on Compose: retry once. Only on-screen nodes exist in
   the dump: scroll first, then locate.

The recipe declares which backends the app supports; try in order, stay on
the first that works for the session, drop to the next only on failure.
Whichever backend is active: re-acquire the tree after navigation, scroll, or
any layout change; same-screen steps reuse it.

## Action channel

- Tap: `adb shell input tap <cx> <cy>` at the bounds center.
- Text: `adb shell input text ...`; keys: `adb shell input keyevent ...`.
- Where the toolkit provides semantic actuation (hook or instrumentation),
  prefer it over raw coordinate taps.

## Step 1 — BuildConfig support

Newer Android Gradle Plugin defaults `buildConfig` off; enable it in the
module's `build.gradle.kts` and keep tests on the debug build type:

```kotlin
android {
    buildFeatures {
        buildConfig = true
    }
    testBuildType = "debug" // default; may be omitted
}
```

## Step 2 — the debug-only tag modifiers

In a shared module (e.g. `:core:ui`), wrap `testTag` so release builds never
inject it. Use the `BuildConfig` of the module that contains the helper (a
library cannot reference the app's `BuildConfig`, and that module needs
`buildConfig` enabled). Keep two layers apart: at runtime
`BuildConfig.DEBUG == false` skips the branch; in the artifact,
`BuildConfig.DEBUG` is not a compile-time constant, so `inline` alone does not
delete the branch or its tag strings. Enable R8 (`isMinifyEnabled = true`)
for physical stripping and verify the tag strings are gone (or use a
`buildConfigField` compile-time boolean — `debug` = `true`,
`release` = `false` — instead):

```kotlin
inline fun Modifier.debugTestTag(tag: String): Modifier =
    if (BuildConfig.DEBUG) this.testTag(tag) else this

inline fun Modifier.debugTestTagWithMerge(tag: String): Modifier =
    if (BuildConfig.DEBUG) {
        this.semantics(mergeDescendants = true) { }.testTag(tag)
    } else {
        this
    }
```

An index-based variant `debugTestTag(prefix, index)` → `user_item_3` exists in
the wild, but indexes drift as rows are inserted/removed and off-screen rows
are not composed. **Use it only when the row genuinely has no stable business
id** — prefer `debugTestTag("order_row/ORD-123")` with the real id, which is
what the registry's row locators expect.

## Step 3 — instrumentation conventions

- Name tags `screen/component` (`login/submit_button`) — the tag becomes the
  registry's identity key and, with the bridge enabled, shows up in dumps as
  `resource-id="login/submit_button"`, exactly as authored, without an added
  package prefix. View resource IDs still use their normal `package:id/name` form.
- Tag what tests touch: navigation, primary actions, inputs, and row
  containers (rows by business id, never by index).
- **Merged semantics for compound widgets**: a card or list row whose
  descendants (image, price, name) would otherwise surface as many loose
  nodes gets ONE `debugTestTagWithMerge("cart/item_card")` on the container —
  descendants merge into a single addressable node. **Highest-priority
  pitfall: if a test must tap an inner control, do not merge at the parent
  container** — merged descendants collapse into the parent and disappear
  from `uiautomator dump`; keep that subtree unmerged (or narrow the merge),
  or fall back to coordinate taps. Prefix list-row tags with the business id
  (e.g. `cart/item_card/ORD-123`). Tag an inner control separately only for
  Compose tests that read the unmerged tree.

```kotlin
Button(
    onClick = { viewModel.doLogin() },
    modifier = Modifier.debugTestTag("login/submit_button"),
) { Text("登录") }

Row(
    modifier = Modifier
        .fillMaxWidth()
        .debugTestTagWithMerge("cart/item_card")
        .clickable { /* detail */ },
) {
    Image(painter = ..., contentDescription = "商品图片")
    Column {
        Text("iPhone 18 Pro Max")
        Text("￥9,999", color = Color.Red)
    }
}
```

## Step 4 — make the tags visible to uiautomator

Compose exposes no view ids, and `testTag` is invisible to the accessibility
tree by default. Enable the bridge once at the activity root — and at every
dialog/popup content root, because dialogs host a separate window the root
flag never reaches:

```kotlin
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId

// testTagsAsResourceId is experimental — add
// @OptIn(ExperimentalComposeUiApi::class) to the enclosing declaration.
setContent {
    Box(Modifier.semantics { testTagsAsResourceId = true }) {
        AppRoot()
    }
}
```

After this, `adb shell uiautomator dump` carries each tag as
`resource-id="login/submit_button"` — the registry matches the raw tag.
This is the [Compose UiAutomator mapping](https://developer.android.com/develop/ui/compose/testing/interoperability#uiautomator):
`By.res("login/submit_button")`, without adding a package prefix.

## Step 5 — verify & troubleshoot (live channel)

- **Build variant**: tests only see tags on the debug build type
  (`BuildConfig.DEBUG == true`); a release-variant run finds nothing (see
  step 2).
- **uiautomator channel**: grep the dump for `resource-id="login/submit_button"`,
  parse `bounds`, tap the center. Stale/empty dump → re-run once before
  concluding.
- **Inside merged nodes**: merging hides descendants from the default
  (merged) view — Compose tests can pass the unmerged tree:
  `onNodeWithTag("cart/delete_icon", useUnmergedTree = true)`. But
  `uiautomator dump` has no unmerged tree: merged child text collapses into
  the parent and the child nodes disappear from the XML. **Highest-priority
  pitfall**: if a test must tap an inner control, do not merge at the parent
  container — keep it unmerged / narrow the merge scope, or use coordinate
  taps.
- **Lazy lists**: only on-screen rows exist in the tree — scroll to the row,
  then locate by its business-id tag.

## Instrumentation testing — the scripted fast path

For stable flows, instrumentation tests (Espresso/Compose test) are the
fastest GUI testing there is: millisecond-level control location and
assertions against the real semantics tree, deterministic, CI-friendly. They
are the regression layer of the toolkit — **writing the test classes is
implementation work**, and running them needs nothing but the built APKs.

```kotlin
@RunWith(AndroidJUnit4::class)
class LoginFlowTest {
    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun login() {
        composeTestRule.onNodeWithTag("login/submit_button").performClick()
        // Merged-node text is asserted on the merged tree; passing
        // useUnmergedTree=true here would look at the container node and miss it.
        composeTestRule.onNodeWithTag("cart/item_card")
            .assertTextContains("iPhone 18 Pro Max")
    }
}
```

**Tree inspection inside a test**:
`composeTestRule.onRoot(useUnmergedTree = true).printToLog("COMPOSE_TREE")`
prints the semantics tree at that point in the test to Logcat — testTag, text,
and node positions, merged or unmerged, with no dependency on the bridge flag.
Place it after the scenario's actions inside the same test. `onRoot()` expects
a single root; with Dialog/Popup roots, inspect the specific roots or use the
multi-window dump hook.

Each separate `am instrument` invocation using `createAndroidComposeRule`
[launches a new Activity and tears it down after the test](https://developer.android.com/guide/components/activities/testing).
It cannot inspect and preserve a live driver's current navigation, form input,
or scroll state. Keep instrumentation dumps inside the scripted scenario;
live `gui dump` / `locate` / `assert-screen` use the hook or uiautomator above,
even when a test APK is installed.

**Running from the command line** (agent-runnable): build once with
`./gradlew assembleDebug assembleDebugAndroidTest`, install both APKs, then

    adb shell am instrument -e class com.example.LoginFlowTest \
        -w com.example.test/androidx.test.runner.AndroidJUnitRunner

Failures come back on stdout. Requires the test dependencies
(`androidx.compose.ui:ui-test-junit4` plus an instrumentation runner) and the
debug build type from step 1. The recipe may wrap this as
`gui instrument <class>`.

## Registry mapping

Tags land in `gui-test/registry/<screen>.yaml` as identity-key locators:

```yaml
screen: Login
signature: [login/username_input, login/submit_button]
controls:
  - alias: submit_button
    locate: { id: "login/submit_button" }
    fallback: { text: "@string/login_submit" }
  - alias: item_card
    scope: cart_list
    locate: { id: "cart/item_card/{biz_id}" }
```

The screen signature is the expected tag set on entry — verify it before the
first action so a wrong screen fails loudly instead of clicking blind.
