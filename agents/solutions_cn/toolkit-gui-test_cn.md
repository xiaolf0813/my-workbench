> 本文件为中文参考译文，仅供查阅；实际部署的是 agents/solutions/toolkit-gui-test.md 英文原文。

# gui-test 工具链——构建规格

这是项目 `gui-test/` 工具链的构建规格：建什么、按什么顺序建、每步如何验收。平台无关：配合对应的 `*-gui-test.md` 平台指南使用，该指南承载所属平台的取树方式、身份键与动作通道。

## 布局

    gui-test/
      README.md                  # 配方：如何启动、取树、操作本应用
      registry/<screen>.yaml     # 每屏：alias -> 定位链 + 界面签名
      gui                        # 薄 CLI：locate / assert-screen / dump

- **`README.md`**——一页：启动应用、取树命令、动作命令、表面事实（adb 序列号、dev-server URL、调试端口）。验收：agent 仅凭此文件即可从"启动应用"走到"dump + 按身份操作"。
- **`registry/<screen>.yaml`**——每屏一份，alias → 定位链（平台身份键优先，其次 text，再 content-desc，最后层级路径；列表行带 scope），外加**界面签名**（预期身份集合，用于走错屏检测）。先对被测屏幕手写；自动化后置。

  ```yaml
  screen: Login
  signature: [login/username_input, login/submit_button]
  controls:
    - alias: submit_button
      locate: { id: "com.example.app:login/submit_button" }
      fallback: { text: "@string/login_submit" }
    - alias: order_row
      scope: order_list
      locate: { id: "com.example.app:order_row/{biz_id}" }   # 运行时参数
  ```

- **`gui` CLI**——薄脚本，文本进出：`locate <screen> <alias> [--scope k=v]` 现算并打印 bounds + 中心；`assert-screen <screen>` 离屏非零、在屏为零退出；`dump` 打印文本树（每节点身份 + bounds）。

## 铁律

- 坐标永不存储；bounds 永远在动作时刻从当前树现算。窗口尺寸、密度、旋转、字体缩放由此构造性失效。
- 身份标记是 app 源码改动；登记表只引用它们，绝不复制它们。
- 同屏步骤复用已取的树；导航、滚动或任何布局变化后重新取树。

## 构建顺序

1. **配方**（`gui-test/README.md`）——见上方验收。
2. **身份标记**：加到测试需要的交互节点上（按对应平台指南）。验收：手动 dump 能看到这些节点上的身份。
3. **登记表 + `gui` CLI**。验收：`assert-screen` 离屏非零、在屏为零退出；`locate` 打印 bounds + 中心。
4. **生成器 + CI 漂移检查**——从源码再生成登记表；CI 在出现悬空 alias 时失败并点名。验收：改名一个 locator，CI 失败并点名悬空 alias。
5. **可选**——应用内语义 dump 钩子作为真值后端。

工具链落地后，把惯例拷进项目自己的说明文件（根 AGENTS.md），让后续会话无需本次部署即可继承。
