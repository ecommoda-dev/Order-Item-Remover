# Order Item Remover — EcomModa

أداة داخلية لفريق خدمة العملاء لحذف منتج واحد لسه Unfulfilled من أوردر COD غير
مسدد، بدل إلغاء الأوردر كله.

- **الواجهة:** GitHub Pages — `index.html`
- **الـ Backend:** Cloudflare Worker — `index.js` (Shopify Order Editing API)
- **قواعد التشغيل والتفاصيل:** [`CLAUDE.md`](./CLAUDE.md)

هذا الريبو هو المصدر الوحيد للكود — أي تعديل يتم هنا وينشر تلقائيًا عبر
Cloudflare Workers Builds (للـ Worker) وGitHub Pages (للواجهة) عند الـ push
على `main`.
