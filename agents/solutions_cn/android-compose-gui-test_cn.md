> 中文参考译文；部署版为 `agents/solutions/android-compose-gui-test.md`。

# Android Compose —— GUI 测试埋点与定位配方

为 Jetpack Compose 应用埋点，让 gui-test 能定位控件并说明测试解析方式；附 Compose 平台规格（取树、动作通道）。埋点与登记表是实现工作，解析与驱动消费它们。配合 `gui-test/README.md`、`toolkit-gui-test.md`（更具体处以后者为准）。两种模式：**live**（经树解析操作）与 **scripted**（仪器化测试，回归层）。

## live 取树 —— 按以下顺序

1. **应用内语义 dump 钩子**（debug）——广播/深链触发时遍历自身语义树，输出 JSON（tag、text、contentDescription、role、enabled、boundsInWindow），覆盖所有 window（含弹窗）。毫秒级、不陈旧，直接读 `SemanticsProperties.TestTag`，无需步骤四的桥接 flag。
2. **`adb shell uiautomator dump`**——钩子不可用时的零侵入兜底。身份呈现为 `resource-id`（View 天然支持；Compose 的 testTag 需步骤四桥接 flag）。Compose 上可能陈旧或空：重试一次。dump 只有屏上节点：先滚动再定位。

配方声明应用支持哪些后端；按序尝试，会话内锁定第一个可用者、仅失败时降级。导航/滚动/布局变化后重取树；同屏步骤复用。

## 动作通道

- 点击 `adb shell input tap <cx> <cy>`（bounds 中心）；文本/按键用 `input text` / `input keyevent`。
- 有语义操作（钩子或仪器化）时优先于坐标点击。

## 步骤一 —— BuildConfig 支持

新版 AGP 默认关闭 `buildConfig`；模块级 `build.gradle.kts` 中开启，并让测试跑 debug 构建类型：

```kotlin
android {
    buildFeatures {
        buildConfig = true
    }
    testBuildType = "debug" // 默认即 debug，可省略
}
```

## 步骤二 —— Debug 专用标签修饰符

公共模块（如 `:core:ui`）封装 debug 专用 `testTag`。“Release 不注入”指运行时 `BuildConfig.DEBUG == false`、分支不执行、不写 tag；但该字段非编译期常量，`inline` 只做内联、不删分支与 tag 字符串，未开 R8 时 Release 包内仍有死代码。`BuildConfig` 用所在模块的（library 不能引用 App 的），并开启 `buildConfig`。要物理零残留：Release 开 R8（`isMinifyEnabled = true`）并验证字符串不残留；或不依赖 R8，改用 `buildConfigField` 生成 debug `true` / release `false` 的编译期常量代替 `BuildConfig.DEBUG`：

```kotlin
inline fun Modifier.debugTestTag(tag: String): Modifier =
    if (BuildConfig.DEBUG) testTag(tag) else this

inline fun Modifier.debugTestTagWithMerge(tag: String): Modifier =
    if (BuildConfig.DEBUG) this.semantics(mergeDescendants = true) { }.testTag(tag) else this
```

按下标的 `debugTestTag(prefix, index)` 变体（如 `user_item_3`）会随列表增删漂移、离屏行不被组合；**仅在行无稳定业务 id 时使用**，优先 `debugTestTag("order_row/ORD-123")` 用真实业务 id（登记表行定位器所需）。

## 步骤三 —— 埋点规范

- tag 命名 `界面/控件`（`login/submit_button`）：tag 是登记表身份键，打开桥接后在 dump 中原样呈现为 `resource-id="login/submit_button"`，不额外添加包名前缀。View 资源 ID 仍用其常规的 `package:id/name` 格式。
- 打标测试会碰到的控件：导航、主操作、输入框、列表行容器（行用业务 id，不用下标）。
- **复合组件用合并语义**：卡片/行的后代（图片、价格、名称）否则散成多个松散节点——容器上加 `debugTestTagWithMerge("cart/item_card")` 合并为单个可寻址节点；列表行拼业务 id。**⚠️ 最高优先级避坑：测试需要点击内部控件时，不要在父容器上整体合并**（uiautomator dump 中后代节点会消失），应缩小合并范围或改用坐标点击；详见步骤五。

```kotlin
Button(
    onClick = { viewModel.doLogin() },
    modifier = Modifier.debugTestTag("login/submit_button"),
) { Text("登录") }

Row(
    modifier = Modifier
        .fillMaxWidth()
        .debugTestTagWithMerge("cart/item_card")
        .clickable { /* 详情 */ },
) {
    Image(painter = ..., contentDescription = "商品图片")
    Column {
        Text("iPhone 18 Pro Max")
        Text("￥9,999", color = Color.Red)
    }
}
```

## 步骤四 —— 让 tag 对 uiautomator 可见

Compose 不暴露 view id，`testTag` 默认不进无障碍树。在 Activity 根打开桥接；Dialog/Popup 内容根也要打开——弹窗是独立 window，Activity 根的 flag 覆盖不到：

```kotlin
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId

// testTagsAsResourceId 为实验 API：所在声明需加 @OptIn(ExperimentalComposeUiApi::class)
setContent {
    Box(Modifier.semantics { testTagsAsResourceId = true }) { AppRoot() }
}
```

此后 dump 中每个 tag 即 `resource-id="login/submit_button"`，登记表匹配原始 tag。[Compose 官方 UiAutomator 映射](https://developer.android.com/develop/ui/compose/testing/interoperability#uiautomator)使用 `By.res("login/submit_button")`，不额外添加包名前缀。

## 步骤五 —— 验证与排障（live 通道）

- **构建变体**：仅 debug 可见 tag；release 下标签不注入（见步骤二）。
- **uiautomator**：dump 中 grep `resource-id="login/submit_button"`，解析 `bounds` 点中心；陈旧/空 dump 先重跑一次。
- **合并节点内部**：合并会隐藏后代——Compose 测试可用未合并树：`onNodeWithTag("cart/delete_icon", useUnmergedTree = true)`；uiautomator dump 无未合并树，后代文本并入父节点、子节点从 XML 消失。**⚠️ 最高优先级避坑**：要点击内部小按钮时不要整体合并，须保持不合并/缩小合并范围，或改用坐标点击。
- **懒列表**：树中只有屏上行——先滚到该行，再按业务 id tag 定位。

## 仪器化测试 —— 脚本化快路径

对稳定流程，仪器化测试（Espresso/Compose test）是最快的 GUI 测试：毫秒级定位与断言、直连真实语义树、确定性强、CI 友好，是工具链回归层——**测试类属于实现工作**，运行只需两个构建好的 APK。

```kotlin
@RunWith(AndroidJUnit4::class)
class LoginFlowTest {
    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun login() {
        composeTestRule.onNodeWithTag("login/submit_button").performClick()
        composeTestRule.onNodeWithTag("cart/item_card")
            .assertTextContains("iPhone 18 Pro Max")
    }
}
```

**测试内部取树**：在同一个测试完成场景操作后调用 `composeTestRule.onRoot(useUnmergedTree = true).printToLog("COMPOSE_TREE")`，将该时刻的语义树（testTag、text、节点坐标，可选合并/未合并）写入 Logcat，无需桥接 flag。`onRoot()` 要求单根；有 Dialog/Popup 多根时，分别检查对应根，或用覆盖多窗口的 dump 钩子。

每次单独运行使用 `createAndroidComposeRule` 的 `am instrument`，都会[新建 Activity，并在测试结束后清理](https://developer.android.com/guide/components/activities/testing)，无法在保留 live driver 当前导航、表单输入或滚动状态的同时检查它。仪器化 dump 只在同一脚本化场景内部使用；live 的 `gui dump` / `locate` / `assert-screen` 使用上面的钩子或 uiautomator，即使已安装测试 APK 也如此。

**命令行运行**（agent 可执行）：`./gradlew assembleDebug assembleDebugAndroidTest` 构建一次、装两个 APK，然后

    adb shell am instrument -e class com.example.LoginFlowTest \
        -w com.example.test/androidx.test.runner.AndroidJUnitRunner

失败走 stdout；需要 `androidx.compose.ui:ui-test-junit4` 与 instrumentation runner，以及步骤一的 debug 构建类型。可包装成 `gui instrument <class>`。

## 登记表映射

tag 落入 `gui-test/registry/<screen>.yaml`，作为身份键定位器：

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

界面签名是进屏时的预期 tag 集合——首个动作前先校验，让走错屏大声失败，而不是盲点。
