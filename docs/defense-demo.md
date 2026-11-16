# Defense demo script — Applicant process

> Taglish ang paliwanag at sagot. Ang screen names, button labels at field names ay **English, eksakto
> kung paano nakasulat sa UI** (naka-**bold** o naka-`code`).

**Objective 1:** "Centralize applicant tracking and scheduling by consolidating inquiries, monitoring
applicant progress and managing schedules in one record, reducing overlooked inquiries and scheduling conflicts."

**Ang rule sa bawat stage (ito ang uulit-ulitin natin):**
required details → may proof na naka-attach → chine-check ng **ibang tao** → **Accept**, o **Return with reason**
na may required na dahilan → lahat naka-log (sino, ano, kailan).
Sales ang naghahanda at nagsu-submit. Admin ang nagre-review. Hindi kayang i-verify ng Sales ang sarili niyang submission,
at ang API mismo ang nagbabawal, hindi lang ang UI.

---

## 1. Paghahanda (isang araw bago ang defense)

### Mga account (magkakahiwalay na browser window o incognito)
| Window | Account | Gamit |
|---|---|---|
| 1 | Admin | reviewer at final approver |
| 2 | Sales (ang **Assigned Sales**) | naghahanda at nagsu-submit |
| 3 | Sales Two (ibang Sales user, **hindi** assigned) | pang-demo ng 403 |
| 4 | Marketing | inquiries at follow-ups |
| 5 | Branch Portal (franchisee account) | pang-demo ng Active Franchisee |

Gumawa ng **Sales Two** sa Users screen bago ang araw ng defense.

### Mga demo file
Lahat nasa `docs/demo-files/` at may tatak na "SAMPLE - NOT A REAL DOCUMENT". Tingnan ang
`docs/demo-files/README.md` kung aling file ang para sa aling field. **Huwag gumamit ng totoong ID o resibo.**

### Mga record na ihahanda (may oras na rules, kaya kailangang naka-set na bago ang defense)
Hindi puwedeng mag-schedule sa nakaraan ("Activities cannot be scheduled in the past."), at ang
**Mark Complete** ay lumalabas lang pagdating ng scheduled start time. Kaya ihanda ito:

| Record | Stage / estado | Para sa tanong |
|---|---|---|
| **Applicant A** ("Demo Applicant") | Qualification. Naka-submit na ang requirements: ang ilan **Accepted**, ang **Initial interview** ay **Waiting for review**, at may isang hindi pa naisu-submit | Q1, Q2, Q3, Q5 |
| **Applicant B** | Activities. Isang Orientation na naka-schedule nang **maaga sa mismong araw ng defense** (hal. 8:00 AM, para pwede nang i-Complete), at isang activity na naka-schedule **bukas** | Q6 |
| **Applicant C** | Payment Record. **Agreed Package Amount** = ₱50,000.00, may isang **Verified** entry (OR-DEMO-0001, ₱20,000.00) | Q7, Q10 |
| **Applicant D** | **Active Franchisee** na (dumaan sa lahat ng stage) | Q4 |
| **Applicant E** | Brand Confirmation, pagkatapos ng Product Tasting (Done) | Q9 |
| 2–3 inquiries | ang isa ay lumampas na sa 7 araw (**Overdue**), at ang isa ay may **Next follow-up** na due ngayong araw | Q8 |

### Timing (mga 20 minuto)
Intro, 1 min · Q1–Q3, 5 min · Q4–Q5, 3 min · Q6, 3 min · Q7 at Q10, 4 min · Q8, 2 min · Q9, 2 min.
Kung kulang ang oras, unahin ang Q3, Q6, Q7 at Q10.

---

## 2. Ang mga tanong ng panel

### Q1. "How do you know the applicant was really interviewed?"
**Ipakita (window 1, Admin):**
1. **Applicants** → buksan ang Applicant A → **Qualification requirements** → **Initial interview**.
2. Ituro ang mga field: **Interview date**, **Interviewer**, **Interview notes**, at ang file na **Signed interview sheet** (`sample-interview-sheet.pdf`).
3. Ituro kung sino ang **Submitted by** at kailan.
4. I-click ang **Accept**.

**Sabihin:**
"Hindi na po checkbox lang ang interview. Kailangan po ng date, ng pangalan ng interviewer, ng notes na
at least 10 characters, at ng pirmadong interview sheet. Kapag walang file, ayaw ng system:
*'Attach the signed interview sheet.'* Hindi rin puwede ang future date. Pagkatapos, si Admin, na ibang tao,
ang mag-a-**Accept** o mag-**Return with reason**."

**Backup:** sa window 2 (Sales), subukang i-**Submit** ang interview nang walang file. Lalabas ang mensahe sa itaas.

### Q2. "Where is the proof of financial capability?"
**Ipakita:** Applicant A → **Proof of funds** → **Declared investment range** (₱1,000,001 – ₱2,000,000) at
ang **Bank certificate or similar** (`sample-bank-certificate.pdf`). I-hover ang attachment nang mga 2 segundo
para lumabas ang preview.

**Sabihin:**
"Dito po naka-record ang declared range at ang supporting document. Private po ang file: Admin at ang
Assigned Sales lang ang makakabukas, at dumadaan ito sa API na may role check, hindi public link.
Makikita niyo po ang note: *'Files are visible to Admin and the assigned Sales user only.'*"

### Q3. "Can Sales verify its own submission?"
**Ipakita (window 2, Sales):** Applicant A. Walang **Accept** button para sa Sales. Ang nakikita lang ay
**Submit** / **Correct and resubmit**, at ang status na **Waiting for review**.

**Ipakita (window 3, Sales Two):** buksan ang parehong applicant at subukang mag-submit. Refused:
*"Only the assigned Sales user (Sales User) can do this for Demo Applicant."*

**Sabihin:**
"Hindi po. Kahit tawagin pa po ang API nang direkta, may 403 po: *'Only Admin can accept a requirement.
Sales cannot verify its own submission.'* Ganoon din po sa payment (*'Only Admin can verify a payment. Sales
cannot verify its own entry.'*) at sa activity attendance. At kabaligtaran din po: hindi puwedeng mag-upload
si Admin para kay Sales (*'Only the assigned Sales user submits requirements. Admin reviews them.'*).
Kung kailangang palitan ang Sales, si Admin ang mag-**Reassign** at kailangan ng dahilan. Pagkatapos,
ang bagong Sales na ang nakakatanggap ng alerts, at hindi na makakagalaw ang dati."

### Q4. "Who approved it, and is it a different person from who prepared it?"
**Ipakita:** Applicant D → **Application Detail** → tab na **History** (o **Next** hanggang sa huling page).
Ituro ang bawat row: ang action, sino ang gumawa, ang role, at ang date and time. Pagkatapos,
**Print this page** / **Print all pages** o **Export PDF**.

**Sabihin:**
"Bawat action po ay may pangalan, role at oras. Makikita niyo pong si Sales User ang nag-submit at si
Admin ang nag-**Accept**, nag-**Confirm Qualified** at nag-approve. Ang approval po ay double confirmation
at kailangang i-type ang `APPROVE`. Append-only po ang history: kahit sa database, tinatanggihan ang
pag-edit ng history row. Hindi rin po ito nakikita ng Marketing; 403 po siya sa report."

### Q5. "What happens when a requirement is missing?"
**Ipakita (window 1, Admin):** Applicant A → hover o click sa **Confirm Qualified**. Disabled ito, at
may nakasulat na listahan ng kulang:
*"Every Qualification requirement must be Accepted first. Missing: …"*

Mag-**Return with reason** din sa isang requirement, at ipakita na hinihingi ang dahilan
("What Sales must correct (at least 5 characters)").

**Sabihin:**
"Hindi po makakausad ang stage hangga't hindi Accepted lahat. Pareho po ang pag-check sa UI at sa API.
Sa LOI po, kailangan ang scan. Bago maging Active Franchisee, kailangan ang **Signed franchise agreement**.
Ang mga lumang record na lampas na sa stage ay hindi namin hinarang; may label po silang
**Legacy record - requirements not captured.**"

### Q6. "Can an activity be completed before its schedule?"
**Ipakita (window 2, Sales):** **Activities & Schedule** → ang activity ni Applicant B na bukas pa.
Walang **Mark Complete**; ang nakasulat ay *"Available on …"*.

Ngayon, ang Orientation kaninang umaga → **Mark Complete** → **Did the applicant attend?**
(**Yes, the applicant attended**) → **Actual date and time** → **Handled by** → **Attendance proof**
(`sample-attendance-sheet.pdf`) → **Submit for Admin review**.

**Ipakita (window 1, Admin):** buksan si Applicant B. Ang status ay **Waiting for Admin review**. I-mark ang
**Attended**, tapos **Save Applicant**. O kaya **Return with reason**.

**Sabihin:**
"Hindi po. Ang **Mark Complete** ay lumalabas lang pagdating ng mismong start time, at nire-refuse din ito
ng API: *'Available on Dec 23, 2026, 9:00 AM.'* Kailangan po ng attendance proof, at si Admin ang
nagsasabing Attended. Kung hindi pumunta, **Mark No Show** na may reason. Ang mga lumang activity na na-complete
bago ang schedule ay may badge na **Completed before schedule (legacy)**. Iniiwasan din po ang scheduling
conflict: bawal ang overlapping slot, bawal ang nakaraan, at bawal sa labas ng working hours."

### Q7. "How do you show payments without billing?"
**Ipakita (window 2, Sales):** Applicant C → **Payment Record**.
Ituro ang **Agreed Package Amount**, ang **Verified** / **Waiting for review** / **Remaining**, at ang status (**Partially Paid**).
**Add payment entry** → **Date paid**, **Amount (₱)** = 30,000, **Method**, **OR / AR number** = `OR-DEMO-0002`,
**Reference number** = `BT-DEMO-0002`, **Receipt** = `sample-receipt-2.jpg` → **Send to Admin**.

**Ipakita (window 1, Admin):** **Verify** → magiging **Fully Paid**.

**Sabihin:**
"Ayon po sa limitation namin, hindi po kami nagbi-billing, hindi kami nagko-compute ng interest, at walang
online payment. Nire-record lang po namin ang bayad na nangyari sa labas ng system, kasama ang resibo.
Ang status ay galing lang sa **Verified** entries. Ang approval at ang COMPLETED ay naa-unlock lang kapag
**Fully Paid**: *'COMPLETED unlocks only when the Payment Record is Fully Paid. Remaining: …'*"

### Q8. "How do you avoid overlooked inquiries?"
**Ipakita (window 4, Marketing):** **Inquiries**.
1. Ituro ang days-in-status at ang **Overdue** badge (lampas 7 araw).
2. Buksan ang isang inquiry → **Follow-up log** → **Log follow-up** (**Channel**, **Outcome**, **Notes**, **Next follow-up**).
3. Ipakita ang notification ng follow-up na due ngayong araw.
4. Gamitin ang date range filter → **Export CSV**.
5. Gumawa ng bagong inquiry gamit ang phone ng existing record. Lalabas ang *"Possible duplicate: …"*, at kailangan ang reason bago **Save with reason**.

**Sabihin:**
"Bawat inquiry po ay may edad at Overdue badge, may log ng bawat follow-up na hindi na mae-edit, at may
reminder kapag due na ang next follow-up. Nahuhuli rin po ang duplicate, kaya hindi nagkakaroon ng dalawang
record para sa iisang tao nang walang paliwanag. Pagka-**Convert**, kailangang pumili ng Sales user, kaya walang
applicant na walang may-hawak. Kung meron mang luma, may badge itong **Unassigned**."

### Q9. "What if the applicant changes brand?" (Brand Confirmation at ang lock)
**Ipakita (window 2, Sales):** Applicant E → **Brand Confirmation** → **Submit final brand**
(**Final brand**, **How the applicant confirmed**, **Date confirmed**, **Notes**).
Kung ibang brand ang pinili sa natikman, hihingi ng dahilan at lalabas ang:
*"Product Tasting will be done again for the new brand."*

**Ipakita (window 1, Admin):** **Confirm Brand** → **Lock the brand?** → **Brand locked**.

**Sabihin:**
"Puwede pong magbago ng isip ang applicant hanggang Brand Confirmation. Kapag iba ang brand sa natikman, uulitin
ang Product Tasting para sa bagong brand bago ito ma-confirm. Kapag na-confirm na ni Admin, naka-lock na:
*'The brand is locked: Admin confirmed it after Product Tasting, so it can no longer be changed.'*
Hindi rin makaka-schedule ng Training hangga't hindi pa confirmed ang brand. Kaya po tugma ang Training, LOI at
Payment Record sa iisang brand."

### Q10. "Sales both receives and records the payment. How do you prevent mistakes or fraud?"
**Ipakita (window 2, Sales):** Applicant C → **Add payment entry** gamit ulit ang **OR / AR number** `OR-DEMO-0001`.
Refused: *"This OR/AR number is already recorded."*
Subukan ding walang receipt (*"Attach the receipt (PDF, JPG or PNG)."*) at sobra sa natitira
(*"This would exceed the Agreed Package Amount: … is left to record."*).

Buksan ang **Payment Record history**.

**Sabihin:**
"Wala po kaming cashier role, kaya ganito po ang controls:
1. **Receipt** ang required sa bawat entry. Chine-check ang mismong laman ng file, hindi lang ang extension.
2. **OR / AR number** at **Reference number** ay unique sa buong system. Database mismo ang nagbabawal, kaya kahit sabay na i-submit, isa lang ang tatanggapin.
3. Hindi lalampas sa **Agreed Package Amount**, at ang pagbabago ng amount ay si Admin lang ang gumagawa, na may dahilan.
4. Si **Admin** ang nagve-**Verify**. Hindi kayang i-verify ng Sales ang sarili niyang entry.
5. **No edits**: *'A payment entry cannot be edited after it is submitted. Admin returns it and Sales records a corrected entry.'*
6. Lahat naka-log sa history, may notification kay Admin pag may bagong entry at kay Sales pag na-verify o na-return."

---

## 3. Pangwakas: mula applicant hanggang branch
**Ipakita (window 5):** **Branch Portal** login gamit ang account ni Applicant D. Gumagana ito, at nakikita
ang bagong branch. Ipakita rin na ang parehong account ay tinatanggihan sa staff login:
*"This sign-in is for franchisor staff accounts only. Use the Branch Portal login instead."*

**Sabihin:**
"Dito po nagdudugtong ang applicant side at ang branch side: pagka-**Mark as Active Franchisee**, may branch na
at may account na ang franchisee sa Branch Portal."

---

## 4. Kung may pumalya sa mismong demo
- **Walang lumabas na Mark Complete:** hindi pa start time. Ito mismo ang rule (Q6). Ipakita ang "Available on …".
- **Walang notification:** i-refresh ang Notifications o ang Inquiries list. Doon nagche-check ng due reminders ang system.
- **Hindi bumukas ang file preview:** i-click ang attachment para i-download. Pareho itong dumadaan sa API.
- **Mabagal ang network:** gamitin ang **Application Detail** → **Export PDF** na inihanda bago ang defense, at ang listahan ng 35 blocked attempts sa `tests/api/walkthrough.test.ts` (`npm run test:api`).

---
---

# Defense demo script — Objective 3: Supply Request and Fulfillment Coordination

> Taglish ang paliwanag. Ang screen names, button labels at field names ay **English, eksakto kung paano
> nakasulat sa UI** (naka-**bold**).

**Ang ipapakita:** isang supply workflow na parang totoong franchise operation. Bawat desisyon ay may
**proof at may dahilang naka-record**, at bawat role ay sariling bahagi lang ang ginagawa (maker-checker):

| Role | Ginagawa |
|---|---|
| Branch (franchisee) | gumagawa, nag-e-edit at nagka-cancel ng sariling request (habang editable pa lang); nagko-confirm ng receipt per item; nagre-report ng damaged o short na may proof |
| Admin | nagre-review; nag-e-endorse na may **Fulfillment decision**; nagre-return, nagre-reject o nagka-cancel; nag-a-approve ng bagong date; nagre-resume ng naka-hold; nagre-resolve ng discrepancy |
| Logistics | nagko-confirm ng schedule o humihingi ng bagong date; nagre-report ng shortage; nagpe-prepare; nagdi-dispatch; nag-e-encode ng POD |

**Ang rule ng stock (uulit-ulitin natin):** **reserved** pag na-endorse → **ibabawas sa warehouse** pag
na-dispatch (ang prepared quantity) → **good lang ang idadagdag sa branch** pag nag-Confirm Receipt.
Pag cancel o reject, ibinabalik ang reservation. Walang stock na gumagalaw nang walang record.

## 1. Paghahanda

### Ang demo data (local lang, hindi kailanman sa live)
Tatlong PowerShell terminal:
```powershell
# 1) Local API na may supply demo data (127.0.0.1:54321)
npm run dev:api:demo

# 2) Staff portal, nakaturo sa LOCAL API (hindi sa .env, na nakaturo sa live)
$env:VITE_SUPABASE_URL='http://127.0.0.1:54321'; $env:VITE_SUPABASE_ANON_KEY='local-dev-anon-key'; $env:VITE_PORTAL='staff'; npx vite --port 5173 --strictPort

# 3) Branch portal, nakaturo rin sa LOCAL API
$env:VITE_SUPABASE_URL='http://127.0.0.1:54321'; $env:VITE_SUPABASE_ANON_KEY='local-dev-anon-key'; $env:VITE_PORTAL='branch'; npx vite --port 5174 --strictPort
```
> **Mahalaga:** huwag laktawan ang `VITE_SUPABASE_URL` sa 2 at 3. Kung wala ito, ang `.env` ang gagamitin, at
> live ang tatamaan ng app. Sa DevTools → Network, dapat `127.0.0.1:54321` ang lahat ng API request.
- Tumatakbo lang ito sa in-memory na database ng `dev:api:demo`; tinatanggihan ng script ang ibang database
  (`supabase/seed/supplyDemo.ts`). Nawawala ang data pag ni-restart, kaya puwedeng ulit-ulitin.
- Dalawang Kkopi branch ang may inventory at **10 linggong usage history**, kaya may totoong **Days covered**
  at **Suggested** sa staff drawer at sa branch form. Ang **Fresh milk** ay **Critical** sa parehong branch.
- May nakahandang request sa bawat sitwasyon sa ibaba. Makikita ang mga number sa terminal ("Supply demo ready").

### Mga account (magkakahiwalay na window o incognito)
| Window | Account | Gamit |
|---|---|---|
| 1 | Admin (`admin@franchisetitan.local`) | review, Fulfillment decision, approvals |
| 2 | Logistics (`logistics@franchisetitan.local`) | schedule, shortage, dispatch, POD |
| 3 | Branch Portal (`franchisee@franchisetitan.local`) — Kkopi - Las Piñas Sample | request, receipt |

### Timing (mga 20 minuto)
Scenario 1 (5 min) → 2–4 (5 min) → 5–7 (4 min) → 8–9 (4 min) → 10 at mga tanong.

## 2. Ang 10 scenario

### Scenario 1. Normal, full stock, end to end
1. **Branch:** **Supply Request Panel** → pumili ng item at quantity → **Add to list**. Ipakita ang **Days covered**
   at ang estimate sa bawat line, ang **Earliest delivery date** (2 working days), tapos **Submit request**.
2. **Admin:** **Supply requests** → tab **Needs my action** → **Review** → **Start review**. Ipakita sa **Items**
   ang Available, Unavailable, Branch stock, Days covered at Suggested → **Endorse – Full**.
   Sabihin: "Naka-reserve na po ang stock; hindi pa ito nababawas."
3. **Logistics:** **Confirm schedule** → **Accept schedule** → **Start preparing** → **Dispatch**
   (driver, 11-digit contact, plate, departure, ETA) → **Print Delivery Receipt**.
   Sabihin: "Ngayon pa lang po nababawas ang warehouse, at ang prepared quantity ang ibinabawas."
4. **Logistics:** **Encode POD** (photo o pirma, received by, actual time).
5. **Branch:** **Confirm receipt** → lahat good → **Completed**. Ipakita ang **Audit trail** sa drawer
   (sino, anong role, kailan, from → to, dahilan).

### Scenario 2. Kulang ang stock, hindi urgent: Hold for Restock, tapos Resume
1. **Admin:** buksan ang request na **On hold** (Caramel syrup). Pindutin ang **Resume request** →
   *"The warehouse cannot cover the held quantities yet…"*. Hindi siya makakalusot.
2. **Logistics:** **Warehouse inventory** → Caramel syrup → **Adjust** → dagdagan.
3. **Admin:** **Resume request** → **Waiting for Logistics**, naka-reserve na ang buong quantity.

### Scenario 3. Kulang at Critical: Partial – Ship Now
1. Ipakita ang request na **Critical** (Fresh milk) at ang dahilan ng urgency. Naka-flag ang item na **Critical**
   (branch stock Critical, mas kaunti ang days covered kaysa sa lead time).
2. Nakahanda na ang **-B** backorder. Sa ibang short na request, ipakita ang **Fulfillment decision** →
   **Partial – Ship Now** → ang preview: *"FT-…-B will be created for …"* bago mag-confirm.
3. Magkahiwalay na matatapos ang parent at ang **-B** (makikita ang link sa drawer: **Parent** / **Backorders**).

### Scenario 4. Partial – Consolidated
1. Ipakita ang request na **On hold** na may naka-reserve na Paper cups (**Partial – Consolidated**,
   dahilan: "same trip").
2. Gumawa ng ibang request ng Paper cups (Admin: **New supply request**) at subukang **Endorse – Full**: naka-disable,
   *"Stock is short; choose a Fulfillment Decision."* Hindi makukuha ng iba ang naka-reserve.
3. **Logistics** ay mag-**Adjust** ng cups → **Admin** **Resume request** → sabay-sabay ang alis.

### Scenario 5. Bulk: higit 50% sa suggestion, Return, Edit and resubmit
1. **Branch:** maglagay ng item na sobrang laki ng quantity. Lalabas ang **Bulk reason (required)**. Kung
   wala ito, tatanggihan ng system ang Submit (pati ang Save as draft).
2. **Admin:** buksan ang **Returned – waiting for branch** na request (White sugar) para makita ang flow, o i-**Return
   for correction** ang bago, na may dahilan.
3. **Branch:** sa **My requests**, pindutin ang **Edit and resubmit**, bawasan ang quantity, tapos **Resubmit request**.
   Parehong request number, at nasa audit trail pa rin ang history.

### Scenario 6. Bagong date mula sa Logistics: approve, at sa ibang kaso, reject
1. **Admin:** may **New date requested** na chip ang isang row → **Review date** → **Approve new date**.
   Magiging **Scheduled** ito sa bagong date, at aabisuhan ang Logistics at ang branch.
2. **Logistics:** sa ibang request, **Request new date** na may dahilan → **Admin:** **Reject new date**.
   Kailangan ng dahilan, at mananatili ang orihinal na date.

### Scenario 7. Shortage report ng Logistics
1. Ipakita ang **Shortage reported** (White sugar: 6 lang ang nasa shelf sa 8). Naka-block ang prepare at dispatch,
   at hindi ginalaw ang inventory.
2. **Admin:** **Review shortage** → **New fulfillment decision**. Naka-cap ang Available sa actual count →
   **Partial – Ship Now** → may **-B**.

### Scenario 8. Dispatch ng Huwebes, ETA ng Linggo
1. Ipakita ang request na dispatched noong Huwebes na may ETA ng Linggo. Sa dispatch lumabas ang
   *"The ETA is on a weekend…"*. Na-confirm na ng branch ang receipt noong Linggo, kahit wala pang POD,
   at nadagdag agad ang stock.
2. **Logistics:** **Encode POD**, gamit ang oras noong Linggo bilang **Actual delivery** (ini-encode ng Lunes) →
   **Completed**.

### Scenario 9. Damaged items
1. Ipakita ang **Discrepancy review** (Paper cups: 190 good, 10 damaged). Sa drawer, ang litrato ng sira
   (thumbnail na lumalaki) at ang dahilan.
2. Sabihin: "190 lang po ang nadagdag sa branch. Hindi ibinabalik sa warehouse ang sira."
3. **Admin:** **Resolve discrepancy** → piliin ang **Accept loss**, **For Logistics investigation** o
   **Branch to re-request**, may remarks → **Completed with discrepancy**. Aabisuhan ang branch at Logistics.

### Scenario 10. Permissions at required reasons
- **Branch:** nakaka-**Cancel request** habang **Submitted**. Pag **Under review** na, wala nang Cancel o Edit,
  at 422 din ang sagot ng API.
- **Logistics:** walang **Endorse**. 403 ang sagot ng API.
- **Admin:** may **Cancel request** hanggang **Preparing**, pero wala na pag **Dispatched** na.
- Kahit anong **Reason** na blangko, o kulang sa 5 characters, ay tinatanggihan. Pareho ang sinasabi ng form at ng API.
- Lahat ng ito ay may automated test: `tests/api/supply_scenarios.test.ts` (`npm run test:api`).

## 3. Mga tanong ng panel

### "Ano ang proof sa bawat hakbang?"
- **Endorse:** naka-record ang Fulfillment decision per item (available, unavailable, restock date) at ang dahilan ni Admin.
- **Dispatch:** driver, contact, plate, departure at ETA, at ang printed **Delivery Receipt** na may pirma ng
  "Released by" at "Received by".
- **POD:** litrato o pirma, sino ang tumanggap, at ang aktwal na oras.
- **Receipt:** good, damaged at short per item, at litrato ng sira.
- **Audit trail:** append-only, ibig sabihin bawal i-edit o i-delete kahit sa database mismo (may trigger).
  May sino, role, kailan, from → to, action, dahilan, file at details.

### "Bakit may Partial at may Hold? Kailan ang alin?"
- **Hold for Restock:** kapag kayang maghintay ang branch. Isang biyahe lang mamaya, walang hati-hating delivery.
- **Partial – Ship Now:** kapag kailangan na ngayon (lalo na Critical). Ang meron ay aalis na, at ang kulang ay nagiging
  **-B** backorder na may sariling tracking.
- **Partial – Consolidated:** naka-reserve na ang meron para walang ibang makakuha, pero sabay ang alis para iisang
  biyahe lang (halimbawa, malayo ang branch).
- Desisyon ito ni Admin, kaya laging may dahilan na naka-record.

### "Bakit 50% ang bulk check?"
Galing sa existing na forecast ang suggestion, base sa totoong usage ng branch. Kapag lampas 50%, hindi namin
binabawal (baka may fiesta o promo), pero kailangan ng **bulk reason** para makita ni Admin kung bakit.
Setting ito na nababago ni Admin (**Supply settings**). Hindi nito ginagalaw ang forecast mismo.

### "Paano ang weekend?"
Mon–Fri ang working days (2 working days ang lead time, nababago sa **Supply settings**): Mon → Wed, Thu → Mon,
Fri → Tue, Sat/Sun → Wed. Puwedeng weekend ang target date dahil bukas ang branches tuwing weekend, pero may
babala. Ang **Urgent** at **Critical** ay puwedeng next working day, basta may dahilan. Ang POD ay puwedeng
i-encode sa susunod na office day gamit ang aktwal na oras.

### "Paano ang sirang items?"
Good lang ang pumapasok sa stock ng branch. Naka-record ang damaged at short na may dahilan at litrato, at pumupunta
sa **Discrepancy review** ni Admin. Walang automatic na kapalit; kung kailangan pa ng branch, gagawa ito ng bagong request.

### "Bakit hindi kinukwenta ang delivery cost?"
Hindi ito bahagi ng Objective 3 (coordination at accountability ang layunin, hindi costing), at wala pa kaming
maaasahang data para dito (rate per trip, fuel, distansya). Naka-record ang bawat biyahe (driver, plate, oras),
kaya madali itong idagdag sa susunod.

## 4. Mga limitasyon (sabihin nang diretso kung tanungin)
- Hindi binibilang ang **holidays**; Mon–Fri lang ang working days.
- **Iisang lead time** para sa lahat ng branches.
- **Walang GPS**: record lang ang dispatch details (driver, plate, ETA), hindi live tracking.
- **Hindi kinukwenta ang delivery cost.**
- **Walang automatic na kapalit** ng sirang items; bagong request ang paraan.
- Ang overdue alerts ay tumatakbo kapag may nagbukas ng supply lists, isang beses kada 10 minuto (walang hiwalay
  na scheduler); may **run now** si Admin sa API.

## 5. Kung may pumalya sa mismong demo
- **Walang Days covered o Suggested:** siguraduhing `npm run dev:api:demo` (hindi `dev:api`) ang tumatakbo.
- **Hindi bumukas ang Print Delivery Receipt:** i-allow ang pop-ups para sa site.
- **Na-restart ang API at nawala ang mga ginawa:** normal iyon; in-memory ang demo. Ulitin lang ang hakbang.
- **Gusto ng panel ng patunay na ang API mismo ang nagbabawal:** `npm run test:api` → ang 10 scenario sa
  `tests/api/supply_scenarios.test.ts`.
