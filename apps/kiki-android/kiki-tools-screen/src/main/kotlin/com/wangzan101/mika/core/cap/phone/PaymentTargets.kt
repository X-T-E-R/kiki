// Adapted from Mika's IrreversibleDetector (Copyright (c) wangzan101 and Mika contributors), Apache-2.0.
package com.wangzan101.mika.core.cap.phone

import com.wangzan101.mika.core.uistate.Hant
import com.wangzan101.mika.core.uistate.ScreenDiagnosis
import com.wangzan101.mika.core.uistate.ScreenSnapshot
import com.wangzan101.mika.core.uistate.UiElement

/** The Android provider cannot obtain a payment approval. Check the target at the port boundary. */
internal object PaymentTargets {
    private val strong = listOf("支付", "付款", "转账", "下单", "购买", "结算", "结账", "取消订单", "确认收货", "退款")
    private val status = listOf("成功", "记录", "售后", "明细", "方式", "列表", "中心", "入口", "码")
    private val exact = listOf("收银台", "买单", "充值", "储值", "提现", "转出", "打赏", "缴费", "捐赠", "捐款", "预约", "报名")
    private val english = Regex("^(pay|donate|place order|buy now|checkout)\\b", RegexOption.IGNORE_CASE)
    private val generic = setOf("确认", "确定", "ok", "完成", "confirm", "提交", "确认提交", "submit")
    private val total = listOf("合计", "实付", "应付", "总计", "checkout total", "amount due")
    private val amount = Regex("[¥￥$＄]\\s*\\d|\\d+(\\.\\d+)?\\s*元")
    private val resourceWords = setOf("pay", "checkout")
    private val activatingKeys = setOf(23, 62, 66, 160)

    fun tap(s: ScreenSnapshot, x: Int?, y: Int?, label: String? = null): Boolean {
        if (paymentPage(s)) return true
        val at = if (x == null || y == null) emptyList() else s.elements.filter { e ->
            e.bounds.size == 4 && x in e.bounds[0]..e.bounds[2] && y in e.bounds[1]..e.bounds[3]
        }
        val target = at.filter { it.clickable }.minByOrNull(::area) ?: at.minByOrNull(::area)
        if (target?.editable == true) return false
        val row = if (y == null || target?.name?.isNotBlank() == true) emptyList() else s.elements.filter { e ->
            e.bounds.size == 4 && y in e.bounds[1]..e.bounds[3] && e.bounds[3] - e.bounds[1] <= 150
        }
        return target?.let { element(s, it) } == true || row.any { element(s, it) } || label?.let { label(s, it) } == true
    }

    fun key(s: ScreenSnapshot, code: Int): Boolean {
        if (code !in activatingKeys) return false
        if (paymentPage(s)) return true
        val focused = s.elements.firstOrNull { it.focused }
        if (focused != null && !focused.editable) return element(s, focused)
        return code != 62 && hasPayableTotal(s)
    }

    fun element(s: ScreenSnapshot, e: UiElement): Boolean = !e.editable && (
        label(s, e.name) || e.resourceId?.substringAfterLast('/')?.replace(Regex("([a-z0-9])([A-Z])"), "$1_$2")
            ?.lowercase()?.split('_', '-', '.')?.any { it in resourceWords } == true
    )

    private fun label(s: ScreenSnapshot, label: String): Boolean = explicit(label) ||
        (Hant.fold(label).filterNot(Char::isWhitespace).lowercase().trimEnd { !it.isLetterOrDigit() } in generic &&
            (hasPayableTotal(s) || s.elements.any { explicit(it.name) }))

    private fun explicit(label: String): Boolean {
        val folded = Hant.fold(label).trim()
        if (english.containsMatchIn(folded)) return true
        val compact = folded.filterNot(Char::isWhitespace)
        if (compact in setOf("红包", "发红包", "塞钱进红包") || compact.startsWith("提交订单") && compact.length <= 8) return true
        if (exact.any { word -> listOf("", "立即", "确认", "去").any { compact == it + word } }) return true
        return (listOf(compact) + folded.split(Regex("\\s+"))).any { raw ->
            val text = raw.replace("支付宝", "").replace("支付方式", "").replace("支付设置", "")
            text.length <= 12 && strong.any { word ->
                generateSequence(text.indexOf(word).takeIf { it >= 0 }) { i -> text.indexOf(word, i + 1).takeIf { it >= 0 } }.any { i ->
                    text.getOrNull(i - 1) !in listOf('待', '已') && status.none { text.substring(i + word.length).trimStart { c -> !c.isLetterOrDigit() }.startsWith(it) }
                }
            }
        }
    }

    private fun paymentPage(s: ScreenSnapshot): Boolean = ScreenDiagnosis.paymentText(s.elements.map { it.name }) != null
    private fun hasPayableTotal(s: ScreenSnapshot): Boolean {
        val text = Hant.fold(s.elements.filterNot { it.editable || it.hint }.joinToString(" ") { it.name }).lowercase()
        return amount.containsMatchIn(text) && (total.any { it in text } || paySheet(s))
    }

    private fun paySheet(s: ScreenSnapshot): Boolean {
        val shown = s.elements.filterNot { it.editable || it.hint }
        if (shown.any { e -> listOf("立即购买", "加入购物车", "立即下单").any { it in Hant.fold(e.name).filterNot(Char::isWhitespace) } }) return false
        val bottomButton = shown.any { e -> e.clickable && e.bounds.size == 4 && e.bounds[1] >= 500 &&
            Hant.fold(e.name).filterNot(Char::isWhitespace).lowercase().let { n -> n in generic || "支付" in n || "付款" in n } }
        return shown.any { e ->
            val text = Hant.fold(e.name).filterNot(Char::isWhitespace).replace(Regex("支持[^\\s，,。]{0,8}?(?:付款|支付)|货到付款|先用后付|花呗|分期|付款方式说明"), "")
            listOf("支付方式", "付款方式", "支付宝", "银行卡", "收银台", "免密").any { it in text } ||
                Regex("(?<![A-Za-z0-9_])(pay|payment|checkout total)(?![A-Za-z0-9_])", RegexOption.IGNORE_CASE).containsMatchIn(text) ||
                bottomButton && e.bounds.size == 4 && e.bounds[1] >= 500 && listOf("余额", "密码", "指纹", "零钱").any { it in text }
        }
    }

    private fun area(e: UiElement) = (e.bounds[2] - e.bounds[0]).toLong() * (e.bounds[3] - e.bounds[1])
}
