// Language-independent structure of lessons/tests — the actual texts live
// in locales/*.json under the lessons.*/tests.*/answers.* keys

export const LESSON_STRUCTURE = [
  {
    "id": 1,
    "key": "right_to_life"
  },
  {
    "id": 2,
    "key": "freedom_of_thought_speech"
  },
  {
    "id": 3,
    "key": "freedom_of_action"
  },
  {
    "id": 4,
    "key": "right_to_property"
  },
  {
    "id": 5,
    "key": "right_to_weapons_for_defense"
  },
  {
    "id": 6,
    "key": "equality_before_law"
  },
  {
    "id": 7,
    "key": "right_to_appeal_translation_enforcement"
  },
  {
    "id": 8,
    "key": "protection_from_judicial_errors"
  },
  {
    "id": 9,
    "key": "protection_of_human_dignity"
  },
  {
    "id": 10,
    "key": "protection_of_children_right_to_refuse_parenting"
  }
];

export const TEST_STRUCTURE = [
  {
    "id": 1,
    "questionKey": "which_is_highest_value",
    "options": [
      {
        "key": "right_to_rest",
        "value": "rest"
      },
      {
        "key": "right_to_work",
        "value": "work"
      },
      {
        "key": "right_to_life",
        "value": "life"
      },
      {
        "key": "right_to_reading",
        "value": "reading"
      }
    ],
    "correctAnswer": "life"
  },
  {
    "id": 2,
    "questionKey": "right_to_life_includes",
    "options": [
      {
        "key": "internet_education",
        "value": "internet"
      },
      {
        "key": "food_water_air_warmth_sleep",
        "value": "basic_needs"
      },
      {
        "key": "entertainment_shopping_friends",
        "value": "entertainment"
      },
      {
        "key": "paying_utilities",
        "value": "utilities"
      }
    ],
    "correctAnswer": "basic_needs"
  },
  {
    "id": 3,
    "questionKey": "can_person_defend_with_others",
    "options": [
      {
        "key": "only_alone",
        "value": "alone"
      },
      {
        "key": "only_with_permission",
        "value": "permission"
      },
      {
        "key": "yes_collective_defense",
        "value": "collective"
      },
      {
        "key": "forbidden_by_law",
        "value": "forbidden"
      }
    ],
    "correctAnswer": "collective"
  },
  {
    "id": 4,
    "questionKey": "child_protection_until_age",
    "options": [
      {
        "key": "until_14",
        "value": "14"
      },
      {
        "key": "until_21",
        "value": "21"
      },
      {
        "key": "until_18",
        "value": "18"
      },
      {
        "key": "until_36",
        "value": "36"
      }
    ],
    "correctAnswer": "18"
  },
  {
    "id": 5,
    "questionKey": "freedom_of_thought_protects_from",
    "options": [
      {
        "key": "work_obligation",
        "value": "work"
      },
      {
        "key": "paying_taxes",
        "value": "taxes"
      },
      {
        "key": "specific_clothing",
        "value": "clothing"
      },
      {
        "key": "forcing_beliefs_change",
        "value": "forcing"
      }
    ],
    "correctAnswer": "forcing"
  },
  {
    "id": 6,
    "questionKey": "speech_limitation_allowed",
    "options": [
      {
        "key": "ban_religious_views",
        "value": "religious"
      },
      {
        "key": "when_violate_rights_of_others",
        "value": "violate"
      },
      {
        "key": "ban_officials_criticism",
        "value": "criticism"
      },
      {
        "key": "censorship_political_views",
        "value": "censorship"
      }
    ],
    "correctAnswer": "violate"
  },
  {
    "id": 7,
    "questionKey": "choosing_residence_belongs_to",
    "options": [
      {
        "key": "freedom_of_action",
        "value": "action"
      },
      {
        "key": "right_to_medical_care",
        "value": "medical"
      },
      {
        "key": "right_to_property",
        "value": "property"
      },
      {
        "key": "right_to_fair_trial",
        "value": "trial"
      }
    ],
    "correctAnswer": "action"
  },
  {
    "id": 8,
    "questionKey": "adult_right_to_refuse_parenting",
    "options": [
      {
        "key": "yes_without_judgment",
        "value": "yes"
      },
      {
        "key": "only_by_court_decision",
        "value": "court"
      },
      {
        "key": "forbidden",
        "value": "forbidden"
      },
      {
        "key": "only_if_no_children",
        "value": "no_children"
      }
    ],
    "correctAnswer": "yes"
  },
  {
    "id": 9,
    "questionKey": "what_property_can_be_shared",
    "options": [
      {
        "key": "only_non_material",
        "value": "non_material"
      },
      {
        "key": "both_material_and_non_material",
        "value": "both"
      },
      {
        "key": "none_can_be_shared",
        "value": "none"
      },
      {
        "key": "only_material",
        "value": "material"
      }
    ],
    "correctAnswer": "both"
  },
  {
    "id": 10,
    "questionKey": "what_is_servitude",
    "options": [
      {
        "key": "compensation_for_damage",
        "value": "compensation"
      },
      {
        "key": "limited_use_of_others_property",
        "value": "limited_use"
      },
      {
        "key": "full_disposal_of_others_property",
        "value": "full_disposal"
      },
      {
        "key": "right_to_inheritance",
        "value": "inheritance"
      }
    ],
    "correctAnswer": "limited_use"
  },
  {
    "id": 11,
    "questionKey": "weapon_right_purpose",
    "options": [
      {
        "key": "protect_life_health_property",
        "value": "protection"
      },
      {
        "key": "business_activities",
        "value": "business"
      },
      {
        "key": "status_demonstration",
        "value": "status"
      },
      {
        "key": "hunting_sports",
        "value": "hunting"
      }
    ],
    "correctAnswer": "protection"
  },
  {
    "id": 12,
    "questionKey": "is_weapon_right_unlimited",
    "options": [
      {
        "key": "only_military_students",
        "value": "military"
      },
      {
        "key": "completely_forbidden",
        "value": "forbidden"
      },
      {
        "key": "only_for_defense_no_aggression",
        "value": "defense_only"
      },
      {
        "key": "complete_freedom",
        "value": "complete"
      }
    ],
    "correctAnswer": "defense_only"
  },
  {
    "id": 13,
    "questionKey": "equality_before_law_based_on",
    "options": [
      {
        "key": "equality_regardless_of_gender_age_nationality",
        "value": "absolute"
      },
      {
        "key": "depends_on_wealth",
        "value": "wealth"
      },
      {
        "key": "preference_for_certain_groups",
        "value": "preference"
      },
      {
        "key": "equality_only_in_criminal_cases",
        "value": "criminal_only"
      }
    ],
    "correctAnswer": "absolute"
  },
  {
    "id": 14,
    "questionKey": "presumption_of_innocence_means",
    "options": [
      {
        "key": "innocent_until_proven_guilty",
        "value": "innocent"
      },
      {
        "key": "not_for_minors",
        "value": "not_minors"
      },
      {
        "key": "guilty_until_proven_otherwise",
        "value": "guilty"
      },
      {
        "key": "court_always_acquits",
        "value": "acquits"
      }
    ],
    "correctAnswer": "innocent"
  },
  {
    "id": 15,
    "questionKey": "must_trial_be_public",
    "options": [
      {
        "key": "always_closed",
        "value": "closed"
      },
      {
        "key": "only_if_accused_wants",
        "value": "accused"
      },
      {
        "key": "yes_for_societal_control",
        "value": "public"
      },
      {
        "key": "only_in_criminal_cases",
        "value": "criminal"
      }
    ],
    "correctAnswer": "public"
  },
  {
    "id": 16,
    "questionKey": "right_if_not_speak_court_language",
    "options": [
      {
        "key": "automatic_acquittal",
        "value": "acquittal"
      },
      {
        "key": "refuse_participation",
        "value": "refuse"
      },
      {
        "key": "translation_native_language",
        "value": "translation"
      },
      {
        "key": "change_judge",
        "value": "change_judge"
      }
    ],
    "correctAnswer": "translation"
  },
  {
    "id": 17,
    "questionKey": "can_court_decision_be_appealed",
    "options": [
      {
        "key": "yes_in_higher_instances",
        "value": "yes"
      },
      {
        "key": "no_final_decision",
        "value": "no"
      },
      {
        "key": "only_if_judge_agrees",
        "value": "judge_agrees"
      },
      {
        "key": "within_24_hours",
        "value": "24_hours"
      }
    ],
    "correctAnswer": "yes"
  },
  {
    "id": 18,
    "questionKey": "what_if_judicial_error_caused_harm",
    "options": [
      {
        "key": "nothing",
        "value": "nothing"
      },
      {
        "key": "judge_apology_only",
        "value": "apology"
      },
      {
        "key": "moral_material_compensation",
        "value": "compensation"
      },
      {
        "key": "review_no_compensation",
        "value": "review"
      }
    ],
    "correctAnswer": "compensation"
  },
  {
    "id": 19,
    "questionKey": "person_right_to_be_informed_about",
    "options": [
      {
        "key": "reasons_for_any_rights_restriction",
        "value": "reasons"
      },
      {
        "key": "officials_professional_plans",
        "value": "plans"
      },
      {
        "key": "unused_vacation_days",
        "value": "vacation"
      },
      {
        "key": "judges_income",
        "value": "income"
      }
    ],
    "correctAnswer": "reasons"
  },
  {
    "id": 20,
    "questionKey": "what_is_absolute_value",
    "options": [
      {
        "key": "right_to_dreams",
        "value": "dreams"
      },
      {
        "key": "human_dignity",
        "value": "dignity"
      },
      {
        "key": "right_to_collect",
        "value": "collect"
      },
      {
        "key": "right_to_rest",
        "value": "rest"
      }
    ],
    "correctAnswer": "dignity"
  },
  {
    "id": 21,
    "questionKey": "is_medical_intervention_without_consent_allowed",
    "options": [
      {
        "key": "only_for_minors",
        "value": "minors"
      },
      {
        "key": "always_forbidden",
        "value": "forbidden"
      },
      {
        "key": "only_in_emergency_cases",
        "value": "emergency"
      },
      {
        "key": "yes_always",
        "value": "always"
      }
    ],
    "correctAnswer": "emergency"
  },
  {
    "id": 22,
    "questionKey": "child_rights_under_special_protection",
    "options": [
      {
        "key": "right_to_refuse_parenting",
        "value": "refuse_parenting"
      },
      {
        "key": "right_to_weapons",
        "value": "weapons"
      },
      {
        "key": "safety_development_education_care",
        "value": "safety"
      },
      {
        "key": "right_to_watch_cartoons",
        "value": "cartoons"
      }
    ],
    "correctAnswer": "safety"
  },
  {
    "id": 23,
    "questionKey": "does_policy_protect_psychological_integrity",
    "options": [
      {
        "key": "no_only_physical",
        "value": "no"
      },
      {
        "key": "yes_intimidation_blackmail_forbidden",
        "value": "yes"
      },
      {
        "key": "only_for_pregnant",
        "value": "pregnant"
      },
      {
        "key": "only_working_hours",
        "value": "working"
      }
    ],
    "correctAnswer": "yes"
  },
  {
    "id": 24,
    "questionKey": "right_to_care_for_others_includes",
    "options": [
      {
        "key": "no_one",
        "value": "no_one"
      },
      {
        "key": "only_own_children",
        "value": "own_children"
      },
      {
        "key": "only_officials",
        "value": "officials"
      },
      {
        "key": "close_family_friends_strangers",
        "value": "all"
      }
    ],
    "correctAnswer": "all"
  },
  {
    "id": 25,
    "questionKey": "right_to_refuse_parenting_applies_to",
    "options": [
      {
        "key": "only_women",
        "value": "women"
      },
      {
        "key": "adults_both_genders",
        "value": "both_genders"
      },
      {
        "key": "only_over_40",
        "value": "over_40"
      },
      {
        "key": "forbidden_for_all",
        "value": "forbidden"
      }
    ],
    "correctAnswer": "both_genders"
  },
  {
    "id": 26,
    "questionKey": "right_to_income_from_property",
    "options": [
      {
        "key": "only_from_inheritance",
        "value": "inheritance"
      },
      {
        "key": "no",
        "value": "no"
      },
      {
        "key": "yes",
        "value": "yes"
      },
      {
        "key": "only_real_estate",
        "value": "real_estate"
      }
    ],
    "correctAnswer": "yes"
  },
  {
    "id": 27,
    "questionKey": "what_guaranteed_to_children_under_18",
    "options": [
      {
        "key": "right_to_entrepreneurship",
        "value": "entrepreneurship"
      },
      {
        "key": "right_to_vote",
        "value": "vote"
      },
      {
        "key": "right_to_guardianship",
        "value": "guardianship"
      },
      {
        "key": "right_to_weapons",
        "value": "weapons"
      }
    ],
    "correctAnswer": "guardianship"
  },
  {
    "id": 28,
    "questionKey": "self_defense_right_derived_from",
    "options": [
      {
        "key": "education",
        "value": "education"
      },
      {
        "key": "life",
        "value": "life"
      },
      {
        "key": "movement",
        "value": "movement"
      },
      {
        "key": "speech",
        "value": "speech"
      }
    ],
    "correctAnswer": "life"
  },
  {
    "id": 29,
    "questionKey": "can_censorship_apply_to_artistic_expression",
    "options": [
      {
        "key": "censorship_mandatory",
        "value": "mandatory"
      },
      {
        "key": "yes_always",
        "value": "always"
      },
      {
        "key": "no_if_not_violate_others_rights",
        "value": "no"
      },
      {
        "key": "only_painting",
        "value": "painting"
      }
    ],
    "correctAnswer": "no"
  },
  {
    "id": 30,
    "questionKey": "property_inviolability_means",
    "options": [
      {
        "key": "cannot_sell",
        "value": "sell"
      },
      {
        "key": "cannot_inherit",
        "value": "inherit"
      },
      {
        "key": "cannot_gift",
        "value": "gift"
      },
      {
        "key": "cannot_arbitrarily_take",
        "value": "take"
      }
    ],
    "correctAnswer": "take"
  },
  {
    "id": 31,
    "questionKey": "which_right_allows_spreading_facts_ideas",
    "options": [
      {
        "key": "right_to_medical_care",
        "value": "medical"
      },
      {
        "key": "right_to_free_information_dissemination",
        "value": "information"
      },
      {
        "key": "right_to_fair_trial",
        "value": "trial"
      },
      {
        "key": "right_to_education",
        "value": "education"
      }
    ],
    "correctAnswer": "information"
  },
  {
    "id": 32,
    "questionKey": "reasonable_time_frame_ensures",
    "options": [
      {
        "key": "automatic_case_closing",
        "value": "closing"
      },
      {
        "key": "case_not_drag_too_long",
        "value": "not_long"
      },
      {
        "key": "increased_fines",
        "value": "fines"
      },
      {
        "key": "quick_punishment",
        "value": "punishment"
      }
    ],
    "correctAnswer": "not_long"
  },
  {
    "id": 33,
    "questionKey": "must_safety_be_ensured_during_trial",
    "options": [
      {
        "key": "only_for_prosecutors",
        "value": "prosecutors"
      },
      {
        "key": "yes",
        "value": "yes"
      },
      {
        "key": "no",
        "value": "no"
      },
      {
        "key": "only_for_judges",
        "value": "judges"
      }
    ],
    "correctAnswer": "yes"
  },
  {
    "id": 34,
    "questionKey": "effective_decision_enforcement_means",
    "options": [
      {
        "key": "partial_enforcement",
        "value": "partial"
      },
      {
        "key": "enforcement_as_desired",
        "value": "desired"
      },
      {
        "key": "timely_complete_enforcement",
        "value": "timely"
      },
      {
        "key": "no_enforcement",
        "value": "none"
      }
    ],
    "correctAnswer": "timely"
  },
  {
    "id": 35,
    "questionKey": "which_right_protects_copyright_trademark",
    "options": [
      {
        "key": "right_to_non_material_property",
        "value": "non_material"
      },
      {
        "key": "right_to_education",
        "value": "education"
      },
      {
        "key": "right_to_material_property",
        "value": "material"
      },
      {
        "key": "right_to_weapons",
        "value": "weapons"
      }
    ],
    "correctAnswer": "non_material"
  },
  {
    "id": 36,
    "questionKey": "compensation_for_property_damage_means",
    "options": [
      {
        "key": "apology_only",
        "value": "apology"
      },
      {
        "key": "full_compensation",
        "value": "full"
      },
      {
        "key": "partial_compensation",
        "value": "partial"
      },
      {
        "key": "nothing",
        "value": "nothing"
      }
    ],
    "correctAnswer": "full"
  },
  {
    "id": 37,
    "questionKey": "does_policy_protect_respect_for_dignity",
    "options": [
      {
        "key": "only_for_children",
        "value": "children"
      },
      {
        "key": "yes_integral_part_of_right_to_life",
        "value": "yes"
      },
      {
        "key": "only_in_hospitals",
        "value": "hospitals"
      },
      {
        "key": "no_only_officials_deserve_respect",
        "value": "no"
      }
    ],
    "correctAnswer": "yes"
  },
  {
    "id": 38,
    "questionKey": "personal_integrity_forbids",
    "options": [
      {
        "key": "changing_personal_data",
        "value": "data"
      },
      {
        "key": "changing_hairstyle",
        "value": "hairstyle"
      },
      {
        "key": "wearing_specific_clothing",
        "value": "clothing"
      },
      {
        "key": "any_violence_humiliation",
        "value": "violence"
      }
    ],
    "correctAnswer": "violence"
  },
  {
    "id": 39,
    "questionKey": "what_is_foundation_for_dialogue",
    "options": [
      {
        "key": "right_to_weapons",
        "value": "weapons"
      },
      {
        "key": "freedom_of_thought_speech",
        "value": "speech"
      },
      {
        "key": "right_to_trial",
        "value": "trial"
      },
      {
        "key": "right_to_property",
        "value": "property"
      }
    ],
    "correctAnswer": "speech"
  },
  {
    "id": 40,
    "questionKey": "human_rights_policy_created_for",
    "options": [
      {
        "key": "total_control_by_force",
        "value": "control"
      },
      {
        "key": "isolation_of_people",
        "value": "isolation"
      },
      {
        "key": "peaceful_coexistence_mutual_respect",
        "value": "coexistence"
      },
      {
        "key": "competition_struggle",
        "value": "competition"
      }
    ],
    "correctAnswer": "coexistence"
  },
  {
    "id": 41,
    "questionKey": "right_to_refuse_parenting_without_discrimination",
    "options": [
      {
        "key": "only_after_50",
        "value": "50"
      },
      {
        "key": "only_medical_reasons",
        "value": "medical"
      },
      {
        "key": "no",
        "value": "no"
      },
      {
        "key": "yes",
        "value": "yes"
      }
    ],
    "correctAnswer": "yes"
  },
  {
    "id": 42,
    "questionKey": "property_protection_includes",
    "options": [
      {
        "key": "protection_from_taxes",
        "value": "taxes"
      },
      {
        "key": "protection_from_encroachments",
        "value": "encroachments"
      },
      {
        "key": "protection_from_inflation",
        "value": "inflation"
      },
      {
        "key": "protection_from_natural_disasters",
        "value": "disasters"
      }
    ],
    "correctAnswer": "encroachments"
  },
  {
    "id": 43,
    "questionKey": "right_to_form_clubs_communities",
    "options": [
      {
        "key": "right_to_property",
        "value": "property"
      },
      {
        "key": "right_to_freedom_of_association",
        "value": "association"
      },
      {
        "key": "right_to_life",
        "value": "life"
      },
      {
        "key": "right_to_independent_trial",
        "value": "trial"
      }
    ],
    "correctAnswer": "association"
  },
  {
    "id": 44,
    "questionKey": "presumption_of_innocence_effective",
    "options": [
      {
        "key": "until_suspect_arrest",
        "value": "arrest"
      },
      {
        "key": "after_verdict",
        "value": "verdict"
      },
      {
        "key": "until_court_decision_final",
        "value": "final"
      },
      {
        "key": "never",
        "value": "never"
      }
    ],
    "correctAnswer": "final"
  },
  {
    "id": 45,
    "questionKey": "is_expression_through_clothing_protected",
    "options": [
      {
        "key": "only_for_artists",
        "value": "artists"
      },
      {
        "key": "only_at_home",
        "value": "home"
      },
      {
        "key": "no",
        "value": "no"
      },
      {
        "key": "yes",
        "value": "yes"
      }
    ],
    "correctAnswer": "yes"
  },
  {
    "id": 46,
    "questionKey": "medical_care_belongs_to",
    "options": [
      {
        "key": "right_to_trial",
        "value": "trial"
      },
      {
        "key": "right_to_movement",
        "value": "movement"
      },
      {
        "key": "right_to_life",
        "value": "life"
      },
      {
        "key": "right_to_property",
        "value": "property"
      }
    ],
    "correctAnswer": "life"
  },
  {
    "id": 47,
    "questionKey": "what_is_always_prohibited",
    "options": [
      {
        "key": "refusing_work",
        "value": "work"
      },
      {
        "key": "torture_cruel_treatment",
        "value": "torture"
      },
      {
        "key": "changing_residence",
        "value": "residence"
      },
      {
        "key": "carrying_weapons",
        "value": "weapons"
      }
    ],
    "correctAnswer": "torture"
  },
  {
    "id": 48,
    "questionKey": "psychological_help_belongs_to",
    "options": [
      {
        "key": "right_to_movement",
        "value": "movement"
      },
      {
        "key": "right_to_education",
        "value": "education"
      },
      {
        "key": "right_to_property",
        "value": "property"
      },
      {
        "key": "right_to_life",
        "value": "life"
      }
    ],
    "correctAnswer": "life"
  },
  {
    "id": 49,
    "questionKey": "right_to_access_natural_resources",
    "options": [
      {
        "key": "only_summer",
        "value": "summer"
      },
      {
        "key": "only_for_payment",
        "value": "payment"
      },
      {
        "key": "yes",
        "value": "yes"
      },
      {
        "key": "no",
        "value": "no"
      }
    ],
    "correctAnswer": "yes"
  },
  {
    "id": 50,
    "questionKey": "main_goal_of_all_rights",
    "options": [
      {
        "key": "increase_financial_inequality",
        "value": "inequality"
      },
      {
        "key": "ban_free_speech",
        "value": "ban_speech"
      },
      {
        "key": "strengthen_officials_control",
        "value": "control"
      },
      {
        "key": "peaceful_coexistence_mutual_respect",
        "value": "peaceful"
      }
    ],
    "correctAnswer": "peaceful"
  }
];

export function getRandomTestStructureForUser() {
  const shuffled = [...TEST_STRUCTURE].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, 10);
}
