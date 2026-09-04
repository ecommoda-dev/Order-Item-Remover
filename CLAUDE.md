# حذف منتج من الأوردر (`Order-Item-Remover`)

**بتعمل إيه:** حذف منتج واحد لسه Unfulfilled بالكامل من أوردر COD غير مسدد، بدل إلغاء الأوردر كله.
**مين بيستخدمها:** خدمة العملاء / إدارة الأوردرات
**الإصدار:** Worker `v1.2.0` · الواجهة `v1.2.0` · `MIN_WORKER_VERSION = 1.2.0`

## الروابط

```
الواجهة    : https://ecommoda-dev.github.io/Order-Item-Remover/
الـ Worker : https://order-item-remover-worker.ecommoda-dev.workers.dev
اسم الـ Worker في الداشبورد: order-item-remover-worker     ← لازم يطابق name في wrangler.toml
```

## الـ Endpoints

| `?action=` | بيعمل إيه |
|---|---|
| `lookup_order` | البحث عن أوردر بالاسم + جلب منتجاته Unfulfilled |
| `remove_item` | حذف بند من الأوردر (Order Editing API — quantity → 0، بدون استرجاع مخزون أبدًا) + تحديث `custom.manual_status` (لو الانتقال مسموح) و`custom.cancel_manual_reason` |
| `check_employee` / `register_pin` / `verify_employee` / `log_logout` / `get_employees` | Universal D1 Auth |
| `get_logs` / `get_logs_count` / `get_logs_export` | سجل العمليات |
| `diag` | فحص ذاتي: OAuth · صلاحيات write_order_edits/read_order_edits · D1 · Origin |
| `get_config` | نسخة الـ Worker (لمقارنتها بنسخة الواجهة) |

## D1

```
tool  : order_item_remover
type  : remove_item · remove_failed · login · logout
```

> مسجَّلة في `ecommoda-constants` §7 (v1.3.0) — قبل أول `writeLog`.

> ℹ️ كل `remove_item` ناجح بيكتب سطر تاني تحت `tool = 'metafields_change'` ·
> `type = 'update'` (لو تحديث `custom.manual_status` اتنفذ فعليًا) — القيمتين
> دول مسجَّلين بالفعل في `ecommoda-constants` §7 تحت "Metafields Change Log"،
> مش خاصّين بالأداة دي.

## المضبوط فعليًا في الداشبورد

> اللي **متظبط بالفعل** — مش اللي المفروض يكون. يتحدّث بعد الربط والتحقق (§11).

```
Bindings : DB → ecommoda-dev-logs                     ← لسه محتاج تحقق بعد الربط
Secrets  : WORKER_SECRET · CLIENT_ID · CLIENT_SECRET   ← لسه محتاجين إضافة يدوية + Promote
Vars     : SHOP_DOMAIN                                 ← من [vars] في wrangler.toml — بيتطبّق مع Workers Builds
Build watch paths : * (الافتراضي — لسه ما اتضيّقتش)
compatibility_date: 2026-09-03                         ← اتحرّك 03-09-2026 بعد فحص الأعلام (R12)
```


## `compatibility_date` — اتحرّكت 03-09-2026 (R12)

```
2025-01-01  →  2026-09-03
```

**التاريخ ده بيعمل إيه:** بيقول لكلاودفلير «الكود ده اتكتب على السلوك اللي كان
موجود في اليوم ده». أي إصلاح **بيغيّر سلوك** ونزل بعد التاريخ ده مابيوصلش
للأداة إلا لما التاريخ يتحرّك بإيدك — عشان إصلاح في الـ runtime ما يكسرش أداة
شغّالة من غير ما حد يعمل deploy.

⚠️ **مش نسخة الـ runtime.** الـ Worker شغّال على أحدث runtime دايمًا مهما كان
التاريخ، وباتشات الأمان بتوصل عادي. المتجمّد هو **السلوك** بس.

**الفحص اللي اتعمل قبل التحريك** — كل سلوك اتغيّر افتراضيًا في الفترة دي
اتقارن بالكود الفعلي للأداة دي، مش بالتخمين ومش نقلًا عن أداة تانية:

| العَلَم | من | الأثر المحتمل | على الأداة دي |
|---|---|---|---|
| `fetch_iterable_type_support` | 2026-02-19 | **كاسر** — `Array` كـ body مابقاش يتحوّل لنص | ✅ آمن — كل `body:` في الملف `JSON.stringify(...)` (نص) |
| `strip_authorization_on_cross_origin_redirect` | 2025-09-01 | ترويسة `Authorization` بتتشال عند redirect لأصل تاني | ✅ آمن — مفيش `Authorization` في أي نداء **صادر**؛ شوبيفاي بتاخد `X-Shopify-Access-Token`. الترويسة دي بتتقرا من الطلب **الوارد** بس |
| `enable_nodejs_global_timers` | 2026-02-10 | `setTimeout` بترجّع `Timeout` مش رقم | ✅ آمن — كل النداءات جوّه `new Promise(r => setTimeout(r, …))` ومفيش استخدام لقيمة الإرجاع |
| `nodejs_compat` + `_v2` | 2026-08-04 | بيتفعّلوا افتراضيًا ويضيفوا globals (`process` · `Buffer`…) | ✅ آمن — صفر تعارض أسماء في الملف |
| `urlpattern_standard` · `strip_bom_in_read_all_text` · `text_decoder_replace_surrogates` · `require_returns_default_export` · `rpc_params_dup_stubs` | 2025-05 → 2026-02 | — | ✅ غير منطبقة — `URLPattern` · `readAllText` · `TextDecoder` · `require()` · RPC كلها **صفر استخدام** |
| باقي أعلام `node:*` | 2025-09 → 2026-03 | وحدات Node إضافية | ✅ غير منطبقة — الأداة مش بتستخدم Node |

**مفيش `compatibility_flags`** — الافتراضي مظبوط، ومفيش داعي لأي استثناء.

⚠️ **لو ظهر أي سلوك غريب بعد النشر**، الرجوع خطوة واحدة: رجّع التاريخ لـ
`2025-01-01` وانشر. الأعلام كلها ليها نسخة `disable_*` كمان لو الحاجة لواحد بعينه.


## CORS

`ALLOWED_ORIGINS` صارمة (بدون wildcard) — لأن الأداة **كتابة/هدّامة** (بتحذف بند من أوردر حي).

## قيود جوهرية — قرار متعمَّد

- تشتغل بس على أوردرات `displayFinancialStatus = PENDING` (COD غير متسدد). الأوردرات المتسددة أونلاين ممنوع الحذف منها من هنا — قرار أحمد 26-08-2026، لا استرجاع تلقائي مطبَّق.
- بس البنود اللي كميتها كلها Unfulfilled (مفيش أي جزء اتشحن) قابلة للحذف الكامل.
- الحذف عبر `orderEditSetQuantity(quantity: 0)` — مفيش mutation مباشرة لحذف بند في Shopify (مؤكَّد ضد سكيما 2026-01 الحية).
- محتاج صلاحية `write_order_edits` + `read_order_edits` — **مختلفة عن** `write_orders` العادية. استخدم `?action=diag` للتأكد.
- الحذف مش بيرجع تلقائيًا — لو غلط، المنتج يتضاف يدويًا من شوبيفاي.
- **استرجاع المخزون معطّل دائمًا وغير قابل للتعديل** — قرار أحمد 28-08-2026: المخزن بيستخدم الأداة دي بس لما المنتج يكون فعليًا غير متوفر بالمخزن. `restock: false` مفروضة من الواجهة (شيك بوكس مقفول) **و**من الـ Worker (دفاع مزدوج — أي قيمة من العميل بتتجاهل).
- **كل حذف بيحاول يحدّث** `custom.manual_status → Pending Edit` (بس لو الحالة الحالية `Confirmed` أو `Ready` — الانتقال المسموح الوحيد حسب `ecommoda-order-lifecycle` §1.4، وإلا يتخطاها مع warning) **و**`custom.cancel_manual_reason → عطلان` (دايمًا). نوع الميتافيلد بيتقرا ديناميكيًا من التعريف الحي في شوبيفاي — لو التعريف مش موجود، الخطوة دي تفشل بـ warning بدون ما تأثر على نجاح حذف البند نفسه.
- نافذة التأكيد بتتطلب تأكيدين إلزاميين (مراجعة المخزون + قطع الفاتورة) قبل تفعيل زرار الحذف.
- بعد أي حذف ناجح (نجاح أو تحذير)، الواجهة ترجع تلقائيًا لوضعها الافتراضي (مربع البحث فاضي) — مفيش عرض دائم لتفاصيل العملية في الشاشة، التفاصيل الكاملة في تاب "سجل العمليات".

## خط الأساس بعد النقل

> أداة جديدة من الصفر — مفيش خط أساس سابق تتقارن بيه (§0-ب في `ecommoda-tool-migration-playbook`).

## فخاخ الأداة دي

- **`ALLOWED_ORIGINS` كاملة — الـ TODO اتشال في v1.2.0** (R14). الرابط الفعلي
  (`https://ecommoda-dev.github.io`) موجود، والـ Origin بيتبعت **domain-level**
  (بدون مسار)، فمفيش تعديل مطلوب إلا لو الواجهة نُشرت على دومين مختلف تمامًا.
  التعليق القديم كان بيوحي بالعكس.
- **`SHOP_DOMAIN_FALLBACK` اتشال في v1.2.0** — كان ثابت **ميّت** (صفر استخدام)،
  وهو بقايا من نمط الـ fallback الصامت اللي التلات أدوات التانية مافيهاش منه
  ولا واحد. سيبه كان بيدي فخ جاهز لأي حد يوصّله بعدين: `SHOP_DOMAIN` ناقص
  بيبقى نداء على دومين مزروع بدل خطأ صريح.
- 🐛 **حارس النسخة كان مكسور لحد v1.2.0** — الفحص كان `workerVersion !==
  TOOL_VERSION`، تطابق **حرفي** بين `'1.1.0'` (اللي `get_config` بيرجّعه) و
  `'v1.1.0'` (بادئة الواجهة). المقارنة دي **بتفشل دايمًا**، يعني زرار «⚠️ نسخة
  الـ Worker مختلفة» كان ظاهر على طول حتى والنسختين متطابقتين — **حارس بيصرخ
  دايمًا = حارس مطفي**. بقى `MIN_WORKER_VERSION` + `cmpVersion()` (حد أدنى
  رقمي بيشيل بادئة الـ v) زي باقي الأدوات.
- **`assertEnv` بيتنادى قبل أي نداء شوبيفاي** (من v1.2.0) في `lookup_order`
  و`remove_item`. و`?action=diag` **بيبلّغ نتيجته كنص مابيرميش** — الغرض منه
  إنه يشتغل بالظبط لما حاجة ناقصة.

## استرجاع النسخ القديمة

> غير منطبق — أداة جديدة، مفيش نسخ قديمة.

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v2.0.0 (جزئيًا — assertEnv + حارس WORKER_SECRET من v1.2.0) |
| ecommoda-html-builder | v1.0.0 |
| shopify-graphql-helper | v1.0.0 |
| ecommoda-order-lifecycle | v1.1.0 |
| ecommoda-constants | v1.2.0 |

آخر مطابقة: 03-09-2026 · `index.js` v1.2.0 · `index.html` v1.2.0
🔴 معلّقة: — لا شيء

## مسائل مفتوحة

### ✅ اتقفلت في v1.2.0 (مراجعة الكود 03-09-2026)

- ~~**R14** — الأداة خارج معيار v2.0.0~~ — `assertEnv` اتضاف · الـ `TODO`
  المضلّل اتشال · `SHOP_DOMAIN_FALLBACK` الميّت اتشال · حارس النسخة المكسور
  اتصلّح (بند اتكشف أثناء التنفيذ، مش في المراجعة).
- ~~**R6** — مفيش حارس لـ `WORKER_SECRET` الغايب~~ — اتضاف.
- ~~**R12** — `compatibility_date` غير موحّد~~ — اتحرّك لـ 2026-09-03 بعد فحص
  الأعلام على الكود الفعلي (القسم فوق).

### لسه مفتوحة

- `ecommoda-html-builder` الحالية v1.1.0 بينما بصمة الواجهة v1.0.0 — الفرق كله بنود 🟡 مُستحسن (فلتر شهر محدد · فصل عمود التاريخ/الوقت · Freeze on Scroll للهيدر/التابات)، مفيش بند 🔴. تتطبّق لما الأداة تتفتح لسبب تاني — مش الآن.
- `Build watch paths` لسه `*` الافتراضي — يستاهل تضييق لـ `index.js` + `wrangler.toml` بعد أول تحقق ناجح (§13-ب في `ecommoda-tool-migration-playbook`).
- الأداة اتبنيت مباشرة من الصفر (§9 في `ecommoda-tool-migration-playbook`) — مفيش سحب من Cloudflare، الكود مصدره `ecommoda-worker-builder`/`ecommoda-html-builder` مباشرة.
