package dev.kiki.android.host.ui

import android.graphics.Color

/**
 * Shared Kiki paper-and-ink color tokens matching `kiki-gui` (`src/index.css`) across light and dark modes.
 */
object KikiPalette {

    data class Tokens(
        val canvas: Int,
        val paper: Int,
        val panel: Int,
        val hairline: Int,
        val ink: Int,
        val inkSoft: Int,
        val inkFaint: Int,
        val accent: Int,
        val selectedBg: Int,
        val selectedInk: Int,
        val success: Int,
        val amberInk: Int,
        val amberSoft: Int,
        val danger: Int,
        val dangerSoft: Int,
    )

    val Light = Tokens(
        canvas = Color.parseColor("#F2EFE8"),
        paper = Color.parseColor("#FBFAF6"),
        panel = Color.parseColor("#FFFDFA"),
        hairline = Color.parseColor("#E4DDD0"),
        ink = Color.parseColor("#1B1A17"),
        inkSoft = Color.parseColor("#4B453E"),
        inkFaint = Color.parseColor("#665E54"),
        accent = Color.parseColor("#C8401A"),
        selectedBg = Color.parseColor("#DFE8F0"),
        selectedInk = Color.parseColor("#1D4D6D"),
        success = Color.parseColor("#2F6B45"),
        amberInk = Color.parseColor("#87480B"),
        amberSoft = Color.parseColor("#F8EEDD"),
        danger = Color.parseColor("#B0261E"),
        dangerSoft = Color.parseColor("#FAE3D7"),
    )

    val Dark = Tokens(
        canvas = Color.parseColor("#13191C"),
        paper = Color.parseColor("#1B2226"),
        panel = Color.parseColor("#252D31"),
        hairline = Color.parseColor("#354047"),
        ink = Color.parseColor("#EEEAE2"),
        inkSoft = Color.parseColor("#C1C5C5"),
        inkFaint = Color.parseColor("#A2ACAF"),
        accent = Color.parseColor("#EB946F"),
        selectedBg = Color.parseColor("#24323B"),
        selectedInk = Color.parseColor("#A3CBDE"),
        success = Color.parseColor("#9AC6AE"),
        amberInk = Color.parseColor("#E6BD78"),
        amberSoft = Color.parseColor("#322B20"),
        danger = Color.parseColor("#F1A29A"),
        dangerSoft = Color.parseColor("#382A25"),
    )

    fun of(dark: Boolean): Tokens = if (dark) Dark else Light
}
