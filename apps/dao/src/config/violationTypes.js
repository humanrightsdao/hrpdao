// src/config/violationTypes.js
//
// The single source of truth for classifying violations: category →
// specific type → severity. To add, change, or remove a violation type —
// edit ONLY this file, with no changes to the form logic or other
// components.
//
// Severity (severityLevel) — 3 levels that directly correspond to the
// internationally recognized three-tier classification of offenses (not
// tied to any specific country's legislation):
//
//   common law (Anglo-American law):  infraction / misdemeanor / felony
//   continental law (France, Belgium, EU):  contravention / délit / crime
//
//   1 = infraction   — 🟡 Minor violation (Infraction)
//   2 = misdemeanor  — 🟠 Misdemeanor
//   3 = felony       — 🔴 Felony
//
// The severity for a specific post is NEVER entered manually by the
// user — it's always derived automatically from the selected violationTypeId.

export const SEVERITY_LEVELS = {
  1: {
    id: 1,
    key: "infraction",
    labelKey: "severity_infraction",
    label: "Minor violation (Infraction)",
    shortLabel: "Infraction",
    emoji: "🟡",
    color: "#eab308", // yellow-500
  },
  2: {
    id: 2,
    key: "misdemeanor",
    labelKey: "severity_misdemeanor",
    label: "Misdemeanor",
    shortLabel: "Misdemeanor",
    emoji: "🟠",
    color: "#f97316", // orange-500
  },
  3: {
    id: 3,
    key: "felony",
    labelKey: "severity_felony",
    label: "Felony",
    shortLabel: "Felony",
    emoji: "🔴",
    color: "#dc2626", // red-600
  },
};

// categoryId — a stable category slug (do not change it after going to
// production, so as not to "break" already-published posts that
// reference it). labelKey — the i18n key; label — the default text in
// English if no translation exists.

export const VIOLATION_CATEGORIES = [
  {
    id: "life",
    labelKey: "violation_category_life",
    label: "Crimes against life",
    types: [
      {
        id: "life_murder",
        labelKey: "violation_life_murder",
        label: "Murder",
        severityLevel: 3,
      },
      {
        id: "life_attempted_murder",
        labelKey: "violation_life_attempted_murder",
        label: "Attempted murder",
        severityLevel: 3,
      },
      {
        id: "life_incitement_suicide",
        labelKey: "violation_life_incitement_suicide",
        label: "Driving someone to suicide",
        severityLevel: 3,
      },
      {
        id: "life_death_threat",
        labelKey: "violation_life_death_threat",
        label: "Death threat",
        severityLevel: 2,
      },
    ],
  },
  {
    id: "war_crimes",
    labelKey: "violation_category_war_crimes",
    label: "War crimes and crimes against humanity",
    types: [
      {
        id: "war_terrorism",
        labelKey: "violation_war_terrorism",
        label: "Terrorist attack",
        severityLevel: 3,
      },
      {
        id: "war_genocide",
        labelKey: "violation_war_genocide",
        label: "Genocide",
        severityLevel: 3,
      },
      {
        id: "war_civilian_infrastructure",
        labelKey: "violation_war_civilian_infrastructure",
        label: "Shelling of civilian infrastructure",
        severityLevel: 3,
      },
      {
        id: "war_forced_deportation",
        labelKey: "violation_war_forced_deportation",
        label: "Deportation/forced displacement of civilians",
        severityLevel: 3,
      },
      {
        id: "war_human_shields",
        labelKey: "violation_war_human_shields",
        label: "Using civilians as human shields",
        severityLevel: 3,
      },
      {
        id: "war_looting",
        labelKey: "violation_war_looting",
        label: "Looting in a combat zone",
        severityLevel: 3,
      },
    ],
  },
  {
    id: "health",
    labelKey: "violation_category_health",
    label: "Crimes against health",
    types: [
      {
        id: "health_torture",
        labelKey: "violation_health_torture",
        label: "Torture",
        severityLevel: 3,
      },
      {
        id: "health_severe_injury",
        labelKey: "violation_health_severe_injury",
        label: "Severe bodily harm",
        severityLevel: 3,
      },
      {
        id: "health_moderate_injury",
        labelKey: "violation_health_moderate_injury",
        label: "Moderate bodily harm",
        severityLevel: 2,
      },
      {
        id: "health_beating",
        labelKey: "violation_health_beating",
        label: "Beating / minor bodily harm",
        severityLevel: 2,
      },
    ],
  },
  {
    id: "liberty",
    labelKey: "violation_category_liberty",
    label: "Crimes against liberty, honor, and dignity",
    types: [
      {
        id: "liberty_trafficking",
        labelKey: "violation_liberty_trafficking",
        label: "Human trafficking / slavery",
        severityLevel: 3,
      },
      {
        id: "liberty_kidnapping",
        labelKey: "violation_liberty_kidnapping",
        label: "Kidnapping",
        severityLevel: 3,
      },
      {
        id: "liberty_unlawful_detention",
        labelKey: "violation_liberty_unlawful_detention",
        label: "Unlawful deprivation of liberty",
        severityLevel: 2,
      },
      {
        id: "liberty_forced_labor",
        labelKey: "violation_liberty_forced_labor",
        label: "Forced labor",
        severityLevel: 2,
      },
    ],
  },
  {
    id: "sexual",
    labelKey: "violation_category_sexual",
    label: "Crimes against sexual freedom",
    types: [
      {
        id: "sexual_rape",
        labelKey: "violation_sexual_rape",
        label: "Rape",
        severityLevel: 3,
      },
      {
        id: "sexual_violence",
        labelKey: "violation_sexual_violence",
        label: "Sexual violence",
        severityLevel: 3,
      },
      {
        id: "sexual_harassment",
        labelKey: "violation_sexual_harassment",
        label: "Sexual harassment",
        severityLevel: 2,
      },
    ],
  },
  {
    id: "discrimination",
    labelKey: "violation_category_discrimination",
    label: "Discrimination and persecution",
    types: [
      {
        id: "discrimination_political_persecution",
        labelKey: "violation_discrimination_political_persecution",
        label: "Persecution on political/religious grounds",
        severityLevel: 2,
      },
      {
        id: "discrimination_hate_speech",
        labelKey: "violation_discrimination_hate_speech",
        label: "Incitement to hatred (hate speech)",
        severityLevel: 2,
      },
      {
        id: "discrimination_general",
        labelKey: "violation_discrimination_general",
        label: "Discrimination on a protected ground (race, sex, religion, etc.)",
        severityLevel: 2,
      },
      {
        id: "discrimination_bullying",
        labelKey: "violation_discrimination_bullying",
        label: "Harassment / bullying",
        severityLevel: 1,
      },
    ],
  },
  {
    id: "detention_justice",
    labelKey: "violation_category_detention_justice",
    label: "Rights violations during detention and judicial proceedings",
    types: [
      {
        id: "justice_fabricated_case",
        labelKey: "violation_justice_fabricated_case",
        label: "Fabrication of a criminal case",
        severityLevel: 2,
      },
      {
        id: "justice_unlawful_arrest",
        labelKey: "violation_justice_unlawful_arrest",
        label: "Unlawful detention/arrest",
        severityLevel: 2,
      },
      {
        id: "justice_no_lawyer_access",
        labelKey: "violation_justice_no_lawyer_access",
        label: "Denial of access to a lawyer",
        severityLevel: 2,
      },
      {
        id: "justice_unfair_trial",
        labelKey: "violation_justice_unfair_trial",
        label: "Violation of the right to a fair trial",
        severityLevel: 2,
      },
    ],
  },
  {
    id: "property",
    labelKey: "violation_category_property",
    label: "Violations of property rights",
    types: [
      {
        id: "property_destruction",
        labelKey: "violation_property_destruction",
        label: "Unlawful destruction of property",
        severityLevel: 2,
      },
      {
        id: "property_seizure",
        labelKey: "violation_property_seizure",
        label: "Unlawful seizure/confiscation of property",
        severityLevel: 2,
      },
      {
        id: "property_theft",
        labelKey: "violation_property_theft",
        label: "Theft",
        severityLevel: 2,
      },
      {
        id: "property_fraud",
        labelKey: "violation_property_fraud",
        label: "Fraud",
        severityLevel: 2,
      },
    ],
  },
  {
    id: "speech_assembly",
    labelKey: "violation_category_speech_assembly",
    label: "Violations of freedom of speech, assembly, and the press",
    types: [
      {
        id: "speech_journalist_persecution",
        labelKey: "violation_speech_journalist_persecution",
        label: "Persecution of journalists",
        severityLevel: 2,
      },
      {
        id: "speech_assembly_dispersal",
        labelKey: "violation_speech_assembly_dispersal",
        label: "Unlawful dispersal of a peaceful assembly",
        severityLevel: 2,
      },
      {
        id: "speech_censorship",
        labelKey: "violation_speech_censorship",
        label: "Censorship / blocking of media",
        severityLevel: 2,
      },
      {
        id: "speech_assembly_denial",
        labelKey: "violation_speech_assembly_denial",
        label: "Unlawful denial of permission to hold an assembly",
        severityLevel: 1,
      },
    ],
  },
  {
    id: "minor_offenses",
    labelKey: "violation_category_minor_offenses",
    label: "Minor offenses",
    types: [
      {
        id: "minor_defamation",
        labelKey: "violation_minor_defamation",
        label: "Defamation",
        severityLevel: 1,
      },
      {
        id: "minor_hooliganism",
        labelKey: "violation_minor_hooliganism",
        label: "Petty hooliganism",
        severityLevel: 1,
      },
      {
        id: "minor_insult",
        labelKey: "violation_minor_insult",
        label: "Insult",
        severityLevel: 1,
      },
      {
        id: "minor_theft",
        labelKey: "violation_minor_theft",
        label: "Petty theft",
        severityLevel: 1,
      },
    ],
  },
  {
    id: "administrative",
    labelKey: "violation_category_administrative",
    label: "Administrative offenses",
    types: [
      {
        id: "admin_assembly_procedure",
        labelKey: "violation_admin_assembly_procedure",
        label: "Violation of the procedure for holding peaceful assemblies (administrative)",
        severityLevel: 1,
      },
      {
        id: "admin_official_misconduct",
        labelKey: "violation_admin_official_misconduct",
        label: "Minor misconduct by an official",
        severityLevel: 1,
      },
      {
        id: "admin_public_order",
        labelKey: "violation_admin_public_order",
        label: "Violation of public order/amenity rules",
        severityLevel: 1,
      },
    ],
  },
  {
    id: "other",
    labelKey: "violation_category_other",
    label: "Other",
    types: [
      {
        id: "other_unclassified",
        labelKey: "violation_other_unclassified",
        label: "Doesn't fall under the categories listed",
        severityLevel: 1,
        requiresModeratorReview: true,
      },
    ],
  },
];

// A flat list of all violation types — convenient for quick lookup by id
// without traversing the nested category structure.
export const ALL_VIOLATION_TYPES = VIOLATION_CATEGORIES.flatMap((category) =>
  category.types.map((type) => ({
    ...type,
    categoryId: category.id,
    categoryLabel: category.label,
    categoryLabelKey: category.labelKey,
  })),
);

/**
 * Find the full information about a violation type (with its category and
 * severity) by id.
 * @param {string} violationTypeId
 * @returns {object|null}
 */
export function getViolationTypeById(violationTypeId) {
  return (
    ALL_VIOLATION_TYPES.find((type) => type.id === violationTypeId) || null
  );
}

/**
 * Compute the severity (1–3) for the selected violation type.
 * This is the ONLY place where severity is derived from data — it
 * should never be set manually anywhere else.
 * @param {string} violationTypeId
 * @returns {number} 1, 2, or 3. Default — 1, if the type isn't found.
 */
export function getSeverityLevelForType(violationTypeId) {
  const type = getViolationTypeById(violationTypeId);
  return type?.severityLevel ?? 1;
}

/**
 * Get the severity-level object (with emoji, color, label) by numeric
 * level 1–3.
 * @param {number} severityLevel
 * @returns {object}
 */
export function getSeverityInfo(severityLevel) {
  return SEVERITY_LEVELS[severityLevel] || SEVERITY_LEVELS[1];
}
