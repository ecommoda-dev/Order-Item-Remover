# حذف منتج من الأوردر (`Order-Item-Remover`)

**بتعمل إيه:** حذف منتج واحد لسه Unfulfilled بالكامل من أوردر COD غير مسدد، بدل إلغاء الأوردر كله.
**مين بيستخدمها:** خدمة العملاء / إدارة الأوردرات
**الإصدار:** Worker `v1.0.0` · الواجهة `v1.0.0`

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
| `remove_item` | حذف بند من الأوردر (Order Editing API — quantity → 0) |
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

## المضبوط فعليًا في الداشبورد

> اللي **متظبط بالفعل** — مش اللي المفروض يكون. يتحدّث بعد الربط والتحقق (§11).

```
Bindings : DB → ecommoda-dev-logs                     ← لسه محتاج تحقق بعد الربط
Secrets  : WORKER_SECRET · CLIENT_ID · CLIENT_SECRET   ← لسه محتاجين إضافة يدوية + Promote
Vars     : SHOP_DOMAIN                                 ← من [vars] في wrangler.toml — بيتطبّق مع Workers Builds
Build watch paths : * (الافتراضي — لسه ما اتضيّقتش)
```

## CORS

`ALLOWED_ORIGINS` صارمة (بدون wildcard) — لأن الأداة **كتابة/هدّامة** (بتحذف بند من أوردر حي).

## قيود جوهرية — قرار متعمَّد

- تشتغل بس على أوردرات `displayFinancialStatus = PENDING` (COD غير متسدد). الأوردرات المتسددة أونلاين ممنوع الحذف منها من هنا — قرار أحمد 26-08-2026، لا استرجاع تلقائي مطبَّق.
- بس البنود اللي كميتها كلها Unfulfilled (مفيش أي جزء اتشحن) قابلة للحذف الكامل.
- الحذف عبر `orderEditSetQuantity(quantity: 0)` — مفيش mutation مباشرة لحذف بند في Shopify (مؤكَّد ضد سكيما 2026-01 الحية).
- محتاج صلاحية `write_order_edits` + `read_order_edits` — **مختلفة عن** `write_orders` العادية. استخدم `?action=diag` للتأكد.
- الحذف مش بيرجع تلقائيًا — لو غلط، المنتج يتضاف يدويًا من شوبيفاي.

## خط الأساس بعد النقل

> أداة جديدة من الصفر — مفيش خط أساس سابق تتقارن بيه (§0-ب في `ecommoda-tool-migration-playbook`).

## فخاخ الأداة دي

- `ALLOWED_ORIGINS` فيها TODO في الكود لإضافة رابط GitHub Pages "لو مختلف" — الرابط الفعلي (`https://ecommoda-dev.github.io`) موجود بالفعل، والـ Origin بيتبعت domain-level بس (بدون مسار)، فمفيش تعديل مطلوب إلا لو الواجهة نُشرت على دومين مختلف تمامًا.

## استرجاع النسخ القديمة

> غير منطبق — أداة جديدة، مفيش نسخ قديمة.

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v1.0.0 |
| ecommoda-html-builder | v1.0.0 |
| shopify-graphql-helper | v1.0.0 |
| ecommoda-order-lifecycle | v1.1.0 |
| ecommoda-constants | v1.2.0 |

آخر مطابقة: 26-08-2026 · `index.js` v1.0.0 · `index.html` v1.0.0
🔴 معلّقة: — لا شيء

## مسائل مفتوحة

- `ecommoda-html-builder` الحالية v1.1.0 بينما بصمة الواجهة v1.0.0 — الفرق كله بنود 🟡 مُستحسن (فلتر شهر محدد · فصل عمود التاريخ/الوقت · Freeze on Scroll للهيدر/التابات)، مفيش بند 🔴. تتطبّق لما الأداة تتفتح لسبب تاني — مش الآن.
- `Build watch paths` لسه `*` الافتراضي — يستاهل تضييق لـ `index.js` + `wrangler.toml` بعد أول تحقق ناجح (§13-ب في `ecommoda-tool-migration-playbook`).
- الأداة اتبنيت مباشرة من الصفر (§9 في `ecommoda-tool-migration-playbook`) — مفيش سحب من Cloudflare، الكود مصدره `ecommoda-worker-builder`/`ecommoda-html-builder` مباشرة.
