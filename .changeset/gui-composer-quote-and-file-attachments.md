---
"@kiki/gui": minor
---

Composer input interactions: selecting text in the transcript now floats a "Quote" button that chips the selection into the composer and ships it as a Markdown blockquote prefix, and the composer accepts arbitrary dropped/pasted files — non-image files upload via `POST /files` and send as real `{type:'file'}` content parts (images keep their inline base64 path), with a drag-over highlight and upload-in-flight chips that block sending.
