import test from 'node:test'
import assert from 'node:assert/strict'
import { MOBILE_V1_PANEL_HTML, mobileV1PanelScriptError } from '../lib/mobile-v1/panel.mjs'

// 回归：模板字符串会把 \/ 吃掉反斜杠，历史上因此把 /^wss?:\/\//i 写成了 /^wss?:///i，
// 整段脚本解析失败 → 「生成二维码」「生成配对资料」两个按钮全哑（真机踩过）。
test('panel inline script parses', () => {
  assert.equal(mobileV1PanelScriptError(), null)
})

test('panel exposes the original pairing entry and never builds a loopback url', () => {
  assert.ok(MOBILE_V1_PANEL_HTML.includes('pair-original'))
  // 必须用 startsWith 判断（不用正则，避开转义陷阱）
  assert.ok(MOBILE_V1_PANEL_HTML.includes("indexOf('wss://') === 0"))
  assert.ok(!MOBILE_V1_PANEL_HTML.includes('replace(//+$/'), '模板里出现 //+$/ 说明反斜杠被吃掉了')
})
