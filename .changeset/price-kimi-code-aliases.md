---
"@kiki/kap-server": patch
"@kiki/gui": patch
---

Price `kimi-code/*` internal model aliases (`k3`, `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed`) through a checked-in local override layer, so the usage page's cost estimate no longer flags those models as unpriced. Aliases without a verified official price stay unpriced instead of inventing a figure.