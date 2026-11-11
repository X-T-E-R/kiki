# Third-party notices

## scrcpy

- Project: https://github.com/Genymobile/scrcpy
- License: Apache-2.0
- Usage: 以 shell 身份取得系统上下文(ActivityThread / 伪装包名的 Context)的做法仿照 scrcpy。
  源文件头部保留出处:
  - `app/src/main/java/com/wangzan101/mika/shell/ShellContext.kt`

## Apache Commons Compress

- Project: https://commons.apache.org/
- Artifact: `org.apache.commons:commons-compress:1.28.0`
- License: Apache-2.0
- Usage: 以库的形式依赖,用于流式解包沙箱根文件系统的 tar.gz
  (`core/src/main/kotlin/com/wangzan101/mika/core/cap/sandbox/RootfsExtractor.kt`)。
- NOTICE:

```
Apache Commons Compress
Copyright 2002-2025 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (https://www.apache.org/).
```

## Apache Commons Codec

- Project: https://commons.apache.org/
- Artifact: `commons-codec:commons-codec:1.19.0`
- License: Apache-2.0
- Usage: Apache Commons Compress 的传递依赖。
- NOTICE:

```
Apache Commons Codec
Copyright 2002-2025 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (https://www.apache.org/).
```

## Apache Commons IO

- Project: https://commons.apache.org/
- Artifact: `commons-io:commons-io:2.20.0`
- License: Apache-2.0
- Usage: Apache Commons Compress 的传递依赖。
- NOTICE:

```
Apache Commons IO
Copyright 2002-2025 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (https://www.apache.org/).
```

## Apache Commons Lang

- Project: https://commons.apache.org/
- Artifact: `org.apache.commons:commons-lang3:3.18.0`
- License: Apache-2.0
- Usage: Apache Commons Compress 的传递依赖。
- NOTICE:

```
Apache Commons Lang
Copyright 2001-2025 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (https://www.apache.org/).
```

## Kotlin 标准库

- Project: https://kotlinlang.org/
- Artifacts: `org.jetbrains.kotlin:kotlin-stdlib:2.1.20`、`kotlin-stdlib-common:2.1.20`、`kotlin-stdlib-jdk7:1.9.10`、
  `kotlin-stdlib-jdk8:1.9.10`;`org.jetbrains:annotations:23.0.0`
- License: Apache-2.0(依据各自 POM)
- Usage: 以库的形式依赖,打进 APK。

## kotlinx.coroutines

- Project: https://github.com/Kotlin/kotlinx.coroutines
- Artifacts: `org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0`、`kotlinx-coroutines-core-jvm:1.9.0`、`kotlinx-coroutines-android:1.9.0`
- License: Apache-2.0(依据各自 POM)
- Usage: 以库的形式依赖,打进 APK。

## kotlinx.serialization

- Project: https://github.com/Kotlin/kotlinx.serialization
- Artifacts: `org.jetbrains.kotlinx:kotlinx-serialization-core:1.7.3`、`kotlinx-serialization-json:1.7.3`(及其 `-jvm` 变体)
- License: Apache-2.0(依据各自 POM)
- Usage: 以库的形式依赖,打进 APK。

## OpenTelemetry

- Project: https://github.com/open-telemetry/opentelemetry-proto-java
- Artifacts: OTLP trace, common, resource and collector schemas from `io.opentelemetry.proto:opentelemetry-proto:1.11.1-alpha` (build-time only).
- License: Apache-2.0
- Usage: Generate lite OTLP trace messages.

## Protocol Buffers

- Project: https://github.com/protocolbuffers/protobuf
- Artifact: `com.google.protobuf:protobuf-javalite:4.36.2`
- License: BSD-3-Clause (see `app/src/main/assets/licenses/Protocol-Buffers.txt`).
- Usage: Official OTLP messages.

## OkHttp

- Project: https://square.github.io/okhttp/
- Artifact: `com.squareup.okhttp3:okhttp:4.12.0`
- License: Apache-2.0(依据 POM)
- Usage: 以库的形式依赖,用于访问模型接口。

## Okio

- Project: https://github.com/square/okio/
- Artifacts: `com.squareup.okio:okio:3.6.0`、`okio-jvm:3.6.0`
- License: Apache-2.0(依据各自 POM)
- Usage: OkHttp 的依赖。

## AndroidX(含 Jetpack Compose)

- Project: https://developer.android.com/jetpack/androidx
- License: Apache-2.0(依据各自 POM;`androidx.compose:compose-bom:2024.12.01` 只是版本清单,不含代码)
- Artifacts(release 运行时类路径里的全部 AndroidX 组件):
  - Compose 1.7.6:`compose.runtime:runtime`、`runtime-saveable`;`compose.ui:ui`、`ui-geometry`、`ui-graphics`、`ui-text`、
    `ui-unit`、`ui-util`;`compose.foundation:foundation`、`foundation-layout`;`compose.animation:animation`、`animation-core`;
    `compose.material:material-icons-core`、`material-ripple`(以上各含 `-android` 变体)
  - `compose.material3:material3:1.3.1`
  - `activity:activity`、`activity-ktx`、`activity-compose`:1.9.3
  - `lifecycle:*`(common、common-java8、livedata-core、process、runtime、runtime-compose、runtime-ktx、viewmodel、
    viewmodel-ktx、viewmodel-savedstate):2.8.3
  - `core:core`、`core-ktx`:1.13.1;`annotation:annotation`:1.8.1;`annotation-experimental`:1.4.1;
    `arch.core:core-common`、`core-runtime`:2.2.0;`collection:collection`、`collection-ktx`:1.4.4;
    `savedstate:savedstate`、`savedstate-ktx`:1.2.1;`emoji2:emoji2`:1.3.0;`profileinstaller`:1.3.1;
    `startup:startup-runtime`:1.1.1;`concurrent:concurrent-futures`:1.1.0;`autofill`:1.0.0;
    `customview:customview-poolingcontainer`:1.0.0;`graphics:graphics-path`:1.0.1;`interpolator`:1.0.0;
    `tracing`:1.0.0;`versionedparcelable`:1.1.1;`webkit:webkit`:1.12.1(内置浏览器)
- Usage: 界面与系统组件库,打进 APK。

## PRoot

- Project: PRoot
- Copyright: Copyright (C) 2015 STMicroelectronics(作者名单见源码包内 `AUTHORS`)
- License: GPL-2.0-or-later,全文见 `licenses/GPL-2.0.txt`
- Source: https://github.com/proot-me/proot/archive/refs/tags/v5.4.0.tar.gz
- Version: 5.4.0
- SHA-256 (source archive): 29248aac2a7ce10c3bd5ee5602742ec33b2532310ff9cf73b79f3c133e5a5f68
- Usage: 独立可执行程序。由 `tools/sandbox/build-native.sh` 从上述源码编译为
  `app/src/main/jniLibs/arm64-v8a/libproot.so` 与其载入器 `libproot_loader.so`,随 APK 发布;
  Mika 只以子进程方式运行它,不链接它。源码地址、版本与校验值同时记录在 `tools/sandbox/sources.lock`。
  `libproot.so` 不内嵌载入器(只嵌空占位),运行时经 `PROOT_LOADER` 使用 `libproot_loader.so`。
- Modifications: 打了四个补丁,同样以 GPL-2.0-or-later 发布:
  `tools/sandbox/patches/proot-0001-exitkill.patch`(跟踪选项加上 `PTRACE_O_EXITKILL`:PRoot 退出时内核杀掉所有被跟踪的进程);
  `tools/sandbox/patches/proot-0002-seccomp-trap-enosys.patch`(被 PRoot 之外的 seccomp 过滤器以 SIGSYS 拦下的系统调用改为返回
  `-ENOSYS` 并取消信号;arm64 上只带 `AT_EACCESS` 标志的 faccessat2 改发成 faccessat);
  `tools/sandbox/patches/proot-0003-arm64-new-path-syscalls.patch`(arm64 系统调用号表补上 statx 之后新增的带路径调用:
  faccessat2、fchmodat2 做路径转换,execveat、openat2、io_uring_setup、新挂载接口与 *xattrat/file_*attr 返回 `-ENOSYS`;
  并修正调用号查表的越界判断);
  `tools/sandbox/patches/proot-0004-link2symlink-fstat-nonfile.patch`(link2symlink 扩展在 fstat 管道、套接字等非文件描述符时
  不再读未初始化的 stat 结构、把成功的调用改成失败)。
- 附带组件 uthash(BSD 许可证,Copyright (c) Troy D. Hanson):PRoot 源码树以子模块形式引用它,
  只有 `care` 扩展用到;源码归档里该目录为空,Mika 的编译不包含 `care`,因此 `libproot.so` 里没有 uthash 的代码。

## talloc

- Project: talloc (Samba)
- Copyright: Copyright (C) Andrew Tridgell 2004;Copyright (C) Stefan Metzmacher 2006
- License: LGPL-3.0-or-later,全文见 `licenses/LGPL-3.0.txt`;LGPL-3.0 是在 GPL-3.0 之上的附加条款,
  GPL-3.0 全文见 `licenses/GPL-3.0.txt`
- Source: https://www.samba.org/ftp/talloc/talloc-2.4.3.tar.gz
- Version: 2.4.3
- SHA-256 (source archive): dc46c40b9f46bb34dd97fe41f548b0e8b247b77a918576733c528e83abd854dd
- Usage: 只编译 `talloc.c`(未修改),静态链接进独立可执行程序 `libproot.so`;Mika 自身不链接它。
  重新链接所需的全部源码与编译脚本见 `tools/sandbox/`。

## Alpine Linux

- Project: https://alpinelinux.org/
- Version: 3.22.7(aarch64 最小根文件系统),外加 Python 3.12、Node 22、Pillow、pypdf 及其依赖
- License: 各软件包各自的许可证(GPL、LGPL、MIT、BSD、MPL 等);逐个软件包的名称、版本与许可证见
  `app/src/main/assets/runtime/packages.json`,App 的「开源许可」页也逐个列出
- Usage: **随 APK 发布**,文件 `app/src/main/assets/runtime/rootfs.tar.xz`,由 `tools/sandbox/build-runtime.py`
  按 `tools/sandbox/runtime/sources.lock` 从 Alpine 官方源取得并核对签名后生成;Mika 只以子进程方式运行其中的程序,不链接它们。
  GPL/LGPL/MPL 软件包的对应源码(Alpine 的构建配方与上游源码)随每个版本放进 `mika-<版本>-gpl-sources.tar.gz`,
  做法见 `tools/sandbox/README.md`。

## Guava ListenableFuture(由 AndroidX 库引入)

- Project: https://github.com/google/guava
- Artifact: `com.google.guava:listenablefuture:1.0` — Apache-2.0(依 Maven POM)
- Usage: 作为库依赖使用,未修改其代码。

## XZ for Java

- Project: https://tukaani.org/xz/java.html
- Version: 1.10(org.tukaani:xz)
- License: 0BSD(BSD Zero Clause License);Copyright (C) The XZ for Java authors and contributors
- Usage: 首次启动时解压自带的运行环境。

## ZXing

- Project: https://github.com/zxing/zxing
- Artifact: `com.google.zxing:core:3.5.3`
- License: Apache-2.0(依据 Maven POM)
- Usage: 以库的形式依赖,未修改其代码;只用于在 Android 本机生成微信绑定二维码。

## commonmark-java

- Project: https://github.com/commonmark/commonmark-java
- Artifacts: `org.commonmark:commonmark:0.30.1`、`commonmark-ext-gfm-tables:0.30.1`、`commonmark-ext-gfm-strikethrough:0.30.1`
- License: BSD-2-Clause
- Usage: 以库的形式依赖,未修改其代码;把对话里回答的 Markdown 解析成语法树,再由 Mika 自己的界面代码显示
  (`app/src/main/java/com/wangzan101/mika/ui/MarkdownModel.kt`)。
- License text:

```
Copyright (c) 2015, Atlassian Pty Ltd
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## xterm.js

- Project: https://github.com/xtermjs/xterm.js
- Version: `@xterm/xterm` 5.5.0, `@xterm/addon-fit` 0.10.0
- License: MIT
- Usage: 用户终端页面的终端仿真器，随 APK 打包在 `app/src/main/assets/terminal/`。

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```