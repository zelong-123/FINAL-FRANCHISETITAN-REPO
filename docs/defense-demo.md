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
