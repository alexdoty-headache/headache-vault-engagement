-- ============================================================================
-- HEADACHE VAULT - Patient Engagement System
-- Migration 002: Seed Reference Medications
--
-- Source: Headache Vault Database Schema v3.0
--   - Therapeutic_Doses.csv (41 records → RX_PREVENTIVE)
--   - OTC_Medications.csv (29 records → OTC)
--
-- These are the canonical medication lists used by:
--   1. AI medication parser (O-4 onboarding normalization)
--   2. Visit Ready Report generator (step therapy assessment)
--   3. MOH risk calculation (acute med days + OTC thresholds)
-- ============================================================================

BEGIN;

-- ============================================================================
-- RX PREVENTIVE MEDICATIONS (from Therapeutic_Doses.csv)
-- Key subset: the medications patients are most likely to mention during O-4.
-- Full 41-record set; only Phase 1-critical fields populated.
-- ============================================================================

INSERT INTO reference_medications (
    medication_name, generic_name, medication_type, drug_class,
    therapeutic_dose_min, therapeutic_dose_max, dose_unit,
    trial_duration_min_weeks, common_starting_dose, titration_schedule,
    common_side_effects, contraindications, step_therapy_class_count,
    evidence_level, rxnorm_id, source_citation
) VALUES
-- Anticonvulsants
('Topiramate', 'topiramate', 'RX_PREVENTIVE', 'Anticonvulsant',
 100, 200, 'mg/day', 8, '25mg daily', 'Increase by 25mg weekly',
 'Cognitive dysfunction, paresthesia, weight loss, kidney stones',
 'Pregnancy; glaucoma; kidney stones', 'Counts as 1 anticonvulsant',
 'Level A (Established)', '38404', 'AHS 2019; ACP 2025'),

('Valproate/Divalproex', 'divalproex sodium', 'RX_PREVENTIVE', 'Anticonvulsant',
 500, 1500, 'mg/day', 8, '250mg twice daily', 'Increase by 250mg weekly',
 'Weight gain, tremor, hair loss, hepatotoxicity',
 'Pregnancy (ABSOLUTE); liver disease', 'Counts as 1 anticonvulsant',
 'Level A (Established)', '3566', 'AHS 2019; ACP 2025'),

-- Beta-blockers
('Propranolol', 'propranolol', 'RX_PREVENTIVE', 'Beta-blocker',
 80, 240, 'mg/day', 8, '40mg twice daily', 'Increase by 20-40mg every 1-2 weeks',
 'Fatigue, exercise intolerance, depression, bradycardia',
 'Asthma; heart block; severe bradycardia', 'Counts as 1 beta-blocker',
 'Level A (Established)', '8787', 'AHS 2019; ACP 2025'),

('Metoprolol', 'metoprolol', 'RX_PREVENTIVE', 'Beta-blocker',
 100, 200, 'mg/day', 8, '50mg twice daily', 'Increase by 50mg every 2 weeks',
 'Fatigue, dizziness, cold extremities',
 'Heart block; severe bradycardia', 'Counts as 1 beta-blocker',
 'Level B (Probably Effective)', '6918', 'AHS 2019'),

('Atenolol', 'atenolol', 'RX_PREVENTIVE', 'Beta-blocker',
 50, 200, 'mg/day', 8, '25-50mg daily', 'Increase by 25mg every 2 weeks',
 'Fatigue, cold extremities',
 'Asthma; severe bradycardia', 'Counts as 1 beta-blocker',
 'Level B (Probably Effective)', '1202', 'AHS 2019'),

('Timolol', 'timolol', 'RX_PREVENTIVE', 'Beta-blocker',
 20, 30, 'mg/day', 8, '10mg twice daily', 'Increase by 10mg every 2 weeks',
 'Fatigue, bradycardia',
 'Asthma; heart block', 'Counts as 1 beta-blocker',
 'Level A (Established)', '10600', 'AHS 2019'),

('Nadolol', 'nadolol', 'RX_PREVENTIVE', 'Beta-blocker',
 80, 240, 'mg/day', 8, '40mg daily', 'Increase by 40mg every 2 weeks',
 'Fatigue, bradycardia, cold extremities',
 'Asthma; heart block', 'Counts as 1 beta-blocker',
 'Level B (Probably Effective)', '7108', 'AHS 2019'),

-- Tricyclic Antidepressants (TCAs)
('Amitriptyline', 'amitriptyline', 'RX_PREVENTIVE', 'TCA',
 50, 150, 'mg/day', 8, '10-25mg at bedtime', 'Increase by 10-25mg weekly',
 'Sedation, weight gain, dry mouth, constipation',
 'Recent MI; MAO inhibitor use', 'Counts as 1 TCA/antidepressant',
 'Level B (Probably Effective)', '704', 'AHS 2019; ACP 2025'),

('Nortriptyline', 'nortriptyline', 'RX_PREVENTIVE', 'TCA',
 50, 150, 'mg/day', 8, '10-25mg at bedtime', 'Increase by 10-25mg weekly',
 'Less sedation than amitriptyline, dry mouth',
 'Recent MI; MAO inhibitor use', 'Counts as 1 TCA/antidepressant',
 'Level B (Probably Effective)', '7531', 'AHS 2019'),

-- SNRIs
('Venlafaxine', 'venlafaxine', 'RX_PREVENTIVE', 'SNRI',
 150, 225, 'mg/day', 8, '37.5mg daily (XR)', 'Increase by 37.5mg weekly',
 'Nausea, dizziness, insomnia, hypertension',
 'MAO inhibitor use; uncontrolled hypertension', 'Counts as 1 SNRI/antidepressant',
 'Level B (Probably Effective)', '39786', 'AHS 2019; ACP 2025'),

-- Calcium Channel Blockers
('Verapamil', 'verapamil', 'RX_PREVENTIVE', 'CCB',
 240, 960, 'mg/day', 4, '80mg three times daily', 'Increase by 80mg every 1-2 weeks',
 'Constipation, hypotension, edema',
 'Heart block; severe heart failure', 'Counts as 1 CCB (primarily cluster)',
 'Level B (cluster headache)', '11170', 'AHS cluster guidelines'),

-- ARBs
('Candesartan', 'candesartan', 'RX_PREVENTIVE', 'ARB',
 16, 32, 'mg/day', 8, '8mg daily', 'Increase by 8mg every 2 weeks',
 'Dizziness, hypotension',
 'Pregnancy; bilateral renal artery stenosis', 'Counts as 1 ARB',
 'Level B (Probably Effective)', '214354', 'ACP 2025'),

-- ACE Inhibitors
('Lisinopril', 'lisinopril', 'RX_PREVENTIVE', 'ACE Inhibitor',
 20, 40, 'mg/day', 8, '10mg daily', 'Increase by 10mg every 2 weeks',
 'Cough, dizziness, hyperkalemia',
 'Pregnancy; angioedema history', 'Counts as 1 ACE inhibitor',
 'Level C (Possibly Effective)', '29046', 'AHS 2019'),

-- CGRP Monoclonal Antibodies (SC)
('Aimovig', 'erenumab', 'RX_PREVENTIVE', 'CGRP mAbs (SC)',
 70, 140, 'mg/month', 12, '70mg monthly SC', NULL,
 'Injection site reactions, constipation',
 'Hypersensitivity to erenumab', 'CGRP class — typically PA target, not step therapy prerequisite',
 'Level A', '2106729', 'FDA label; AHS 2019'),

('Ajovy', 'fremanezumab', 'RX_PREVENTIVE', 'CGRP mAbs (SC)',
 225, 675, 'mg/month or quarterly', 12, '225mg monthly or 675mg quarterly SC', NULL,
 'Injection site reactions',
 'Hypersensitivity to fremanezumab', 'CGRP class — typically PA target, not step therapy prerequisite',
 'Level A', '2169341', 'FDA label; AHS 2019'),

('Emgality', 'galcanezumab', 'RX_PREVENTIVE', 'CGRP mAbs (SC)',
 120, 240, 'mg/month', 12, '240mg loading, then 120mg monthly SC', NULL,
 'Injection site reactions',
 'Hypersensitivity to galcanezumab', 'CGRP class — typically PA target, not step therapy prerequisite',
 'Level A', '2169348', 'FDA label; AHS 2019'),

-- CGRP Monoclonal Antibodies (IV)
('Vyepti', 'eptinezumab', 'RX_PREVENTIVE', 'CGRP mAbs (IV)',
 100, 300, 'mg/quarter', 12, '100mg IV every 3 months', NULL,
 'Nasopharyngitis, hypersensitivity',
 'Hypersensitivity to eptinezumab', 'CGRP class — typically PA target, not step therapy prerequisite',
 'Level A', '2371894', 'FDA label'),

-- Gepants (Preventive)
('Qulipta', 'atogepant', 'RX_PREVENTIVE', 'Gepants (Preventive)',
 30, 60, 'mg/day', 12, '60mg daily', NULL,
 'Nausea, constipation, fatigue',
 'Avoid with strong CYP3A4 inhibitors', 'CGRP class — typically PA target',
 'Level A', '2566571', 'FDA label'),

-- Gepants (Acute)
('Nurtec ODT', 'rimegepant', 'RX_PREVENTIVE', 'Gepants (Acute)',
 75, 75, 'mg/dose', NULL, '75mg as needed', NULL,
 'Nausea, abdominal pain',
 'Avoid with strong CYP3A4 inhibitors', 'Dual acute/preventive',
 'Level A', '2462001', 'FDA label'),

('Ubrelvy', 'ubrogepant', 'RX_PREVENTIVE', 'Gepants (Acute)',
 50, 100, 'mg/dose', NULL, '50 or 100mg as needed', NULL,
 'Nausea, somnolence',
 'Avoid with strong CYP3A4 inhibitors', 'Acute gepant',
 'Level A', '2371860', 'FDA label'),

-- Neurotoxins
('Botox', 'onabotulinumtoxinA', 'RX_PREVENTIVE', 'Neurotoxins',
 155, 195, 'units/12 weeks', 12, '155 units per session', 'Fixed protocol, 31 injection sites',
 'Neck pain, injection site pain, eyelid ptosis',
 'Infection at injection site; hypersensitivity', 'Neurotoxin class — chronic migraine only (≥15 days)',
 'Level A', '1811538', 'FDA label; PREEMPT protocol'),

-- Other
('Memantine', 'memantine', 'RX_PREVENTIVE', 'NMDA Antagonist',
 10, 20, 'mg/day', 8, '5mg daily', 'Increase by 5mg weekly',
 'Dizziness, headache, confusion',
 'Severe renal impairment', 'Off-label, may not count for step therapy',
 'Level C (Possibly Effective)', '6719', 'Off-label evidence'),

('Gabapentin', 'gabapentin', 'RX_PREVENTIVE', 'Anticonvulsant',
 1200, 2400, 'mg/day', 8, '300mg at bedtime', 'Increase by 300mg every 3-5 days',
 'Sedation, dizziness, weight gain',
 'Severe renal impairment (dose adjust)', 'May count as anticonvulsant for step therapy',
 'Level U (Inadequate Evidence)', '25480', 'AHS 2019'),

('Cyproheptadine', 'cyproheptadine', 'RX_PREVENTIVE', 'Antihistamine',
 4, 16, 'mg/day', 8, '4mg at bedtime', 'Increase by 4mg weekly',
 'Sedation, weight gain, dry mouth',
 'Angle-closure glaucoma; urinary retention', 'Not standard step therapy class',
 'Level C (pediatric use)', '3014', 'AHS pediatric guidelines');


-- ============================================================================
-- OTC MEDICATIONS (from OTC_Medications.csv)
-- Used for MOH risk assessment when patients report acute medication use.
-- ============================================================================

INSERT INTO reference_medications (
    medication_name, generic_name, brand_names, medication_type, drug_class,
    moh_category, moh_threshold_days_per_month,
    active_ingredients, caffeine_content_mg,
    rxnorm_id, notes
) VALUES
-- Combination Analgesics (MOH threshold: ≥10 days/month)
('Excedrin Extra Strength', 'acetaminophen/aspirin/caffeine', 'Excedrin Migraine',
 'OTC', 'Combination Analgesic', 'Combination analgesic', 10,
 'APAP 250mg, ASA 250mg, Caffeine 65mg', 130,
 '217319', 'Caffeine withdrawal contributes to MOH cycle'),

('Excedrin Migraine', 'acetaminophen/aspirin/caffeine', 'Excedrin Extra Strength',
 'OTC', 'Combination Analgesic', 'Combination analgesic', 10,
 'APAP 250mg, ASA 250mg, Caffeine 65mg', 130,
 '217319', 'Same formulation as Extra Strength, different labeling'),

('BC Powder', 'aspirin/caffeine', NULL,
 'OTC', 'Combination Analgesic', 'Combination analgesic', 10,
 'ASA 845mg, Caffeine 65mg', 65,
 NULL, 'Powder form, rapid absorption'),

('Goody''s Extra Strength', 'acetaminophen/aspirin/caffeine', NULL,
 'OTC', 'Combination Analgesic', 'Combination analgesic', 10,
 'APAP 260mg, ASA 520mg, Caffeine 32.5mg', 33,
 NULL, 'Powder form'),

-- Simple Analgesics (MOH threshold: ≥15 days/month)
('Acetaminophen', 'acetaminophen', 'Tylenol, Tylenol Extra Strength',
 'OTC', 'Simple Analgesic', 'Simple analgesic', 15,
 'APAP 325-500mg per tablet', NULL,
 '161', 'Hepatotoxicity risk at high doses'),

('Ibuprofen', 'ibuprofen', 'Advil, Motrin',
 'OTC', 'NSAID', 'Simple analgesic', 15,
 'Ibuprofen 200-400mg per tablet', NULL,
 '5640', 'GI and renal risks with chronic use'),

('Naproxen Sodium', 'naproxen', 'Aleve',
 'OTC', 'NSAID', 'Simple analgesic', 15,
 'Naproxen sodium 220mg per tablet', NULL,
 '7258', 'Longer half-life than ibuprofen'),

('Aspirin', 'aspirin', 'Bayer',
 'OTC', 'NSAID', 'Simple analgesic', 15,
 'ASA 325-500mg per tablet', NULL,
 '1191', 'Antiplatelet effects'),

-- Triptans (Rx but commonly mentioned by patients as acute meds; MOH threshold: ≥10 days/month)
('Sumatriptan', 'sumatriptan', 'Imitrex',
 'OTC', 'Triptan', 'Triptan', 10,
 'Sumatriptan 25-100mg oral, 6mg SC, 20mg nasal', NULL,
 '37418', 'Most commonly prescribed triptan'),

('Rizatriptan', 'rizatriptan', 'Maxalt',
 'OTC', 'Triptan', 'Triptan', 10,
 'Rizatriptan 5-10mg oral', NULL,
 '223181', 'Fast-acting oral triptan'),

('Zolmitriptan', 'zolmitriptan', 'Zomig',
 'OTC', 'Triptan', 'Triptan', 10,
 'Zolmitriptan 2.5-5mg oral/nasal', NULL,
 '114860', NULL),

('Eletriptan', 'eletriptan', 'Relpax',
 'OTC', 'Triptan', 'Triptan', 10,
 'Eletriptan 20-40mg oral', NULL,
 '321988', 'Potent, may work when others fail'),

('Naratriptan', 'naratriptan', 'Amerge',
 'OTC', 'Triptan', 'Triptan', 10,
 'Naratriptan 1-2.5mg oral', NULL,
 '215551', 'Slower onset, longer duration, fewer side effects'),

('Frovatriptan', 'frovatriptan', 'Frova',
 'OTC', 'Triptan', 'Triptan', 10,
 'Frovatriptan 2.5mg oral', NULL,
 '283406', 'Longest half-life triptan, used for menstrual migraine prevention'),

('Almotriptan', 'almotriptan', 'Axert',
 'OTC', 'Triptan', 'Triptan', 10,
 'Almotriptan 6.25-12.5mg oral', NULL,
 '282464', NULL),

-- Caffeine-containing products
('Cafergot', 'ergotamine/caffeine', NULL,
 'OTC', 'Ergot', 'Ergotamine', 10,
 'Ergotamine 1mg, Caffeine 100mg', 100,
 '215569', 'Ergot derivative, strict MOH threshold'),

-- Opioid combinations (Rx, but patients may mention)
('Fioricet', 'butalbital/acetaminophen/caffeine', NULL,
 'OTC', 'Barbiturate Combination', 'Combination analgesic', 10,
 'Butalbital 50mg, APAP 300mg, Caffeine 40mg', 40,
 '238134', 'High MOH risk; dependency risk. Patients often say "that one with the barbiturate"'),

('Fiorinal', 'butalbital/aspirin/caffeine', NULL,
 'OTC', 'Barbiturate Combination', 'Combination analgesic', 10,
 'Butalbital 50mg, ASA 325mg, Caffeine 40mg', 40,
 NULL, 'Aspirin-based version of Fioricet');

COMMIT;
