---
title: solo-ai-gateway — Product Card
doc_id: CARD-solo-ai-gateway
doc_type: product-card
verdict: invest
version: 0.1
date: 2026-10-11
status: ร่างเพื่อพิจารณา
owner: Product owner (Book Dev)
---

# solo-ai-gateway — Product Card

## 1. สรุปคุณค่าในหนึ่งประโยค

ประตูกลางเดียวที่เรียกโมเดล AI ได้อย่างตรวจสอบได้ โดยบังคับ scope ต่อ client, rate limit และ budget และบันทึก telemetry โดยไม่เก็บ prompt/output

## 2. ปัญหาและผู้ใช้เป้าหมาย

agent และแอปหลายตัวเรียกโมเดลหลายค่าย ต้องคุมค่าใช้จ่ายและสิทธิ์ที่เดียว ผู้ใช้คือ agent/แอปของ Solo Empire

## 3. สิ่งที่ทำได้จริงตอนนี้

- HTTPS endpoint `solo-empire.ai-gateway.v1` พร้อม `/healthz` (README)
- โมดูล routing, budget, rate limit, auth ใน `api/` และ telemetry SQLite บน Railway volume `/data`
- เทสต์ node:test 5 ไฟล์ (รันด้วย tsx)

## 4. หลักฐานสถานะ

| รายการ | ค่า |
|---|---|
| Stack | TypeScript (Node, tsx), SQLite |
| Commit | 2 ครั้ง (2026-10-10 ถึง 2026-10-10) |
| ซอร์สโค้ด | 13 ไฟล์ / 3859 บรรทัด |
| เทสต์ | 5 ไฟล์ (ไม่ได้รันในงานนี้) |
| CI | ไม่มี workflow |
| Deploy config | `.railway/railway.ts` + `Dockerfile` (Railway project `solo-ai-gateway`, always-on) |
| Live URL | https://api.bookchaowalit.com (ระบุใน README/ทะเบียน; ไม่ได้ probe สดในงานนี้) |

## 5. คุณค่าและจุดต่าง

- ลดความเสี่ยงต้นทุน: budget และ scope อยู่ที่จุดเดียว
- ไม่เก็บ prompt/output ลด PDPA exposure
- **[สมมติฐาน]** ขายเป็นบริการ gateway ให้ลูกค้ายังไม่มีหลักฐานความต้องการ

## 6. ช่องว่างสำคัญ

- repo เพิ่งแยกออกจาก monorepo (2 commits) ยังไม่มี CI
- telemetry เป็น SQLite บน volume เดียว ไม่มี backup ที่ยืนยันได้ **[ต้องยืนยัน]**

## 7. คำตัดสิน

**`invest`** — ใช้งานจริงเป็นทางผ่านของ AI ทุกตัวในระบบและเป็นจุดคุมค่าใช้จ่าย จะเปลี่ยนเป็น `showcase` หากเจ้าของเลิกใช้ gateway กลาง

## 8. ขั้นต่อไป

1. เพิ่ม CI (build + test) หรือรันผ่าน task กลาง
2. ยืนยันแผน backup ของ telemetry

## การอนุมัติ

| บทบาท | สถานะ | วันที่ | ลงนาม |
|---|---|---|---|
| Product owner (Book Dev) | รอพิจารณา | — | ________ |

## แหล่งข้อมูล

- `README.md`
- `Dockerfile`, `.railway/railway.ts`, `tests/`
