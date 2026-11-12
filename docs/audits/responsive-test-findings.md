> **Arsip historis.** Dokumen ini mempertahankan temuan pada saat ditulis; status dan rencana di bawah dapat berbeda dari kode terbaru. Lihat [README](../../README.md) untuk panduan saat ini.

# Responsive Test Findings

## Initial compact-layout checks

| Viewport | Result | Limitation |
|---|---|---|
| 344×882 | Compact Chat shows one panel; header, Ask Anything composer, and bottom Source/Chat/Watch navigation remain visible. | Sandbox session has no persisted Chat history, so it cannot prove wrapping for the user's real long responses. |
| 430×932 | Same compact structure remains visible without viewport overflow. | Sandbox session has no persisted Chat history, so it cannot prove wrapping for the user's real long responses. |
| 914×412 | Compact Chat keeps the header, Ask Anything composer, and bottom Source/Chat/Watch navigation in the viewport. | Empty Chat state only; long history scroll behavior still requires structural regression plus localhost acceptance testing. |
| 956×440 | Compact Chat keeps the header, Ask Anything composer, and bottom Source/Chat/Watch navigation in the viewport. | Empty Chat state only; long history scroll behavior still requires structural regression plus localhost acceptance testing. |
| 1199×800 | Compact workspace remains in one-panel mode with the switchable bottom navigation visible. | Empty Chat state only. |
| 1200×800 | Desktop workspace switches to the original three separately rounded and resizable panels. | Empty Chat state only. |

The user-provided localhost DevTools screenshots remain the acceptance reference for real Chat history content. Automated regression tests should cover structural width and height contracts at the named viewport sizes.

## HP portrait overflow diagnosis

Browser measurement with a diagnostic Markdown history at 360px, 412px, 414px, and 440px found no horizontal overflow after the final change. The document and every measured compact Chat wrapper report equal client and scroll widths.

The source of the remaining user-visible clipping was the AI bubble's `width: fit-content` behavior: nested Streamdown Markdown can use its intrinsic content width on narrow screens, while the message row's `overflow: hidden` then clips the excess at the right edge. In compact mode, AI bubbles now use the row's bounded available width; nested Streamdown elements are explicitly limited to the inline width and forced to wrap long text. This change is scoped to compact mode and leaves tablet/desktop Chat sizing untouched.
