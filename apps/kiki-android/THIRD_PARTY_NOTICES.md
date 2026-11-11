# Third-Party Open-Source Notices (Kiki Android)

This application (`dev.kiki.app`, **Kiki**) bundles and adapts the components below. License texts and upstream notices are in `licenses/`.

---

## 1. Mika (Screen Accessibility, Phone Tools & Loopback HTTP)

- **Project**: https://github.com/wangzan101/Mika
- **Copyright**: Copyright (c) wangzan101 and Mika contributors
- **License**: Apache License, Version 2.0 (`licenses/Apache-2.0.txt`; upstream notice: `licenses/Mika-NOTICE.txt`)
- **Adapted paths**:
  - `kiki-tools-screen/src/main/kotlin/com/wangzan101/mika/core/`: screen state and stable references (`uistate/`), app access (`access/AppAccess.kt`), link validation (`tool/LinkPolicy.kt`), untrusted text framing (`observation/Untrusted.kt`), and phone queries, wheel geometry, and tool execution (`cap/phone/`). The phone handlers are adapted from Mika's `cap/phone/` and `uistate/tools/` without its agent dispatcher or model runtime.
  - `kiki-tools-screen/src/main/resources/dev/kiki/android/tools/screen/phone-tools.json`: phone tool names, descriptions, and input schemas extracted from the Android tools snapshot.
  - `kiki-tools-screen/src/main/kotlin/dev/kiki/android/tools/screen/`: Android screen port and `a11y/` accessibility, OCR, wheel, and system intent adapters.
  - `kiki-host/src/main/kotlin/dev/kiki/android/host/gateway/HttpServer.kt`: adapted from `core/src/main/kotlin/com/wangzan101/mika/core/remote/HttpServer.kt` for loopback only.

```text
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

## 2. Node.js Bionic Runtime, Termux Packages & nodejs-mobile Architectural Inspiration

- **Node.js Project**: https://nodejs.org/
- **Termux Bionic Packages**: https://github.com/termux/termux-packages (`nodejs-lts` 24.22.2-1, `libc++` 30, `openssl` 3.6.5, `c-ares` 1.34.9, `libicu` 79.1, `libsqlite` 3.54.1-1, `zlib` 1.4 — locked with SHA-256 in `tools/kiki-runtime/node.lock`)
- **nodejs-mobile Reference**: https://github.com/nodejs-mobile/nodejs-mobile (Copyright (c) Janea Systems, MIT License — referenced for Android `nativeLibraryDir` SONAME packaging and local IPC bridge patterns)
- **Licenses**:
  - **Node.js**: MIT License — Copyright Node.js contributors. All rights reserved.
  - **nodejs-mobile** (architectural reference): MIT License — Copyright (c) 2017 Janea Systems.
  - **OpenSSL 3.6.5**: Apache-2.0 — Copyright (c) 1998-2025 The OpenSSL Project Authors.
  - **ICU 79.1**: Unicode-3.0 — Copyright (c) 2016 and later: Unicode, Inc. and others.
  - **c-ares 1.34.9**: MIT License — Copyright (c) 1998 Massachusetts Institute of Technology; Copyright (c) 2007-2024 Daniel Stenberg et al.
  - **SQLite 3.54.1**: Public Domain / Blessing.
  - **zlib 1.4**: Zlib License — Copyright (C) 1995-2024 Jean-loup Gailly and Mark Adler.
  - **LLVM libc++**: Apache-2.0 WITH LLVM-exception — Copyright LLVM Project.

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. Kiki Agent Kernel & Web GUI

- **Project**: Kiki (`@kiki/agent-core-v2`, `@kiki/kap-server`, `kiki-gui`)
- **Copyright**: Copyright (c) Moonshot AI and contributors
- **License**: Apache-2.0 / MIT (per bundled package manifests inside `kiki-dist.tar.xz`)

---

## 4. Android Jetpack / AndroidX Libraries

- **Project**: https://developer.android.com/jetpack/androidx
- **Copyright**: Copyright (c) The Android Open Source Project
- **License**: Apache-2.0
- **Artifacts**:
  - `androidx.activity:activity-ktx:1.9.3`
  - `androidx.core:core-ktx:1.13.1` (including `FileProvider`, `WindowCompat`, `ViewCompat`)
  - `androidx.lifecycle:lifecycle-runtime-ktx:2.8.3`
  - `androidx.webkit:webkit:1.12.1` (`WebViewCompat`, `WebMessageListener`, `DocumentStartJavaScript`)

---

## 5. Kotlin Standard Library, Coroutines & Serialization

- **Projects**:
  - https://kotlinlang.org/ (`org.jetbrains.kotlin:kotlin-stdlib:2.1.20`)
  - https://github.com/Kotlin/kotlinx.coroutines (`org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2`, `kotlinx-coroutines-core:1.10.2`)
  - https://github.com/Kotlin/kotlinx.serialization (`org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3`)
- **Copyright**: Copyright (c) 2010-2025 JetBrains s.r.o. and Kotlin Programming Language contributors
- **License**: Apache-2.0

---

## 6. OkHttp & Okio

- **Projects**: https://square.github.io/okhttp/ (`com.squareup.okhttp3:okhttp:4.12.0`), https://github.com/square/okio (`com.squareup.okio:okio:3.6.0`)
- **Copyright**: Copyright (c) Square, Inc.
- **License**: Apache-2.0

---

## 7. Apache Commons Compress & XZ for Java

- **Apache Commons Compress** (`org.apache.commons:commons-compress:1.28.0`, plus transitive `commons-codec`, `commons-io`, `commons-lang3`):
  - **License**: Apache-2.0 — Copyright 2002-2025 The Apache Software Foundation (`This product includes software developed at The Apache Software Foundation (https://www.apache.org/).`)
- **XZ for Java** (`org.tukaani:xz:1.10`):
  - **Project**: https://tukaani.org/xz/java.html
  - **License**: 0BSD (BSD Zero Clause License) — Copyright (C) The XZ for Java authors and contributors.

---

## 8. Protocol Buffers Java Lite

- **Project**: https://github.com/protocolbuffers/protobuf (`com.google.protobuf:protobuf-javalite:4.36.2`)
- **Copyright**: Copyright 2008 Google Inc. All rights reserved.
- **License**: BSD-3-Clause

---

## 9. Google ML Kit On-Device Text Recognition (Optional Screen OCR)

- **Artifacts**: `com.google.mlkit:text-recognition:16.0.1`, `com.google.mlkit:text-recognition-chinese:16.0.1`
- **Terms**: Google APIs Terms of Service & ML Kit Terms of Service (https://developers.google.com/ml-kit/terms). Runs strictly on-device inside `:kiki-tools-screen` when Accessibility screen reading requests visible-text OCR.
