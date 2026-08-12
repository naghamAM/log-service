# Log Ingestion and Query Service

خدمة TypeScript/PostgreSQL لاستقبال logs منظمة، البحث فيها، وتجميعها زمنياً. صُممت لتكون نسخة مصغرة من Datadog/Loki مع تركيز على صحة البيانات وسرعة الاستعلام.

## التشغيل

المتطلب الوحيد هو Docker Desktop. شغّل:

```bash
docker compose up --build
```

بعد ظهور `Log service listening` افحص الجاهزية:

```bash
curl http://localhost:8080/health
```

للتطوير محلياً: شغّل PostgreSQL من compose، ثم `npm install` و`npm run dev`. متغيرات البيئة المهمة: `DATABASE_URL` و`PGPOOL_MAX` (افتراضياً 8) و`RETENTION_DAYS` (افتراضياً 30).

## API

### `POST /logs`

يرسل دائماً مصفوفة، ويقبل العناصر الصحيحة حتى لو احتوت الدفعة على عناصر خاطئة.

```bash
curl -X POST localhost:8080/logs -H 'content-type: application/json' -d '{"logs":[{"timestamp":"2026-08-12T10:00:00Z","level":"error","service":"checkout","message":"payment declined","attributes":{"user_id":"42","retries":3}}]}'
```

الرد: `{ "accepted": 1, "rejected": [] }`. الحقول المطلوبة هي `timestamp`, `level`, `service`, `message`. المستويات: `debug`, `info`, `warn`, `error`. `attributes` اختياري، مسطح، وقيمه string/number/boolean.

### `GET /logs`

كل المرشحات اختيارية ويمكن دمجها: `service`, `level`, `since`, `until`, `attr.<key>`, `q`, `limit` (1–1000، الافتراضي 100)، و`cursor`. النتائج مرتبة `timestamp DESC, id DESC` للحفاظ على ترتيب ثابت.

```bash
curl 'localhost:8080/logs?service=checkout&level=error&attr.user_id=42&q=declined&limit=100'
```

يعيد `{ "logs": [...], "next_cursor": "..." }` أو `next_cursor: null` عند انتهاء النتائج. يجب تمرير الـ cursor كما عاد في الطلب التالي.

### `GET /logs/aggregate`

يتطلب `since`, `until`, و`bucket` (`1m`, `5m`, `1h`, `1d`). يقبل نفس مرشحات القراءة مع `group_by=service|level`.

```bash
curl 'localhost:8080/logs/aggregate?since=2026-08-12T00:00:00Z&until=2026-08-13T00:00:00Z&bucket=1h&group_by=service'
```

## التصميم

`src/index.ts` هو طبقة HTTP فقط. `validation.ts` يتحقق من كل log بصورة مستقلة. `repository.ts` يبني SQL parameterized ويخزن ويقرأ البيانات. `db.ts` مسؤول عن pool، migrations، وسياسة الاحتفاظ. هذا الفصل يجعل الكود سهل الشرح والاختبار.

الجدول يحتفظ بـ:

- `attributes`: JSONB الأصلي حتى يبقى نوع القيمة كما أرسله العميل.
- `attribute_values`: نسخة JSONB كل قيمها strings. هذا يحقق شرط `attr.key` الذي يقارن `42` و`"42"` كسلاسل، مع فهرس GIN سريع.

فهرس `(timestamp DESC, id DESC)` يدعم الترتيب والـ cursor. وهناك فهارس مركبة لـ service/level مع الوقت، وفهرس GIN للattributes، و`pg_trgm` للبحث الجزئي غير الحساس لحالة الأحرف في الرسالة.

الإدخال الدفعي يستخدم PostgreSQL `UNNEST` في statement واحد، بدلاً من INSERT لكل سجل. الاستعلامات parameterized بالكامل؛ أسماء group-by محصورة بقائمة ثابتة، لذلك لا يوجد SQL injection.

## Retention

تُحذف السجلات الأقدم من `RETENTION_DAYS` عند بدء التطبيق ثم كل ساعة. الحذف يتم على دفعات 10,000 سجل لتجنب عملية طويلة تحجب الكتابة. للإنتاج الأكبر، يمكن تحسين ذلك بـ partitioning شهري وحذف partition كامل.

## قياس الأداء

يوجد smoke/load helper:

```bash
node load-test.js http://localhost:8080 100 100
```

يقيس إدخال 100 طلب، كل منها 100 logs، ويطبع throughput. لا تكتب أرقاماً غير مقاسة في التسليم: شغّله على جهازك بعد `docker compose up` وسجّل البيئة، حجم batch، throughput، وp50/p95 للاستعلام هنا. الأداء يتأثر كثيراً بموارد Docker ونظام الجهاز.

## حدود معروفة

- لا يوجد authentication أو multi-tenancy؛ هي خارج العقد المطلوب.
- aggregate يحسب من الجدول مباشرة؛ عند أحجام أكبر من المطلوب يفضّل إضافة rollups أو partitions.
- load helper اختبار أولي، وليس بديلاً عن أداة متزامنة مثل k6 أو autocannon.

## شرح سريع للديمو

ارسم المسار: **client → Express validation → batch UNNEST → PostgreSQL indexes → query/aggregate**. سبب `attribute_values` هو أن PostgreSQL JSONB يميز رقم `42` عن نص `"42"` بينما المتطلب لا يميّز؛ لذلك نحفظ النسخة الأصلية ونسخة للبحث. سبب cursor هو أن `OFFSET` يصبح بطيئاً كلما كبرت الصفحة، أما cursor فيتابع مباشرة من آخر `(timestamp, id)` ظهر للمستخدم.
