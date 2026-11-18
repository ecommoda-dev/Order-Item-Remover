# Order Item Remover — EcomModa

> 🗑️ **18-11-2026 — الواجهة المستقلة اتحذفت** (قرار أحمد). الريبو ده بقى **Worker فقط**، والواجهة الوحيدة هي `Order-Item-Remover.html` في `Warehouse-Operations-Center`. رابط GitHub Pages القديم بيدّي `404` **بلا إعادة توجيه** بقرار. أي إشارة تحت لـ«الواجهة المستقلة» أو `index.html` بتوصف الوضع قبل الحذف (تاريخية).

أداة داخلية لفريق خدمة العملاء لحذف منتج واحد لسه Unfulfilled من أوردر COD غير
مسدد، بدل إلغاء الأوردر كله.

- **الواجهة:** في الهب فقط (`Order-Item-Remover.html`) — مفيش واجهة مستقلة
- **الـ Backend:** Cloudflare Worker — `index.js` (Shopify Order Editing API)
- **قواعد التشغيل والتفاصيل:** [`CLAUDE.md`](./CLAUDE.md)

هذا الريبو هو المصدر الوحيد للكود — أي تعديل يتم هنا وينشر تلقائيًا عبر
Cloudflare Workers Builds (للـ Worker) عند الـ push
على `main`.
