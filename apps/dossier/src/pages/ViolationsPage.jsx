// src/pages/ViolationsPage.jsx
import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  MapPin,
  Upload,
  X,
  AlertCircle,
  CheckCircle,
  Calendar,
  FileText,
  Mail,
  Search,
  Map as MapIcon,
  List,
} from "lucide-react";
import Layout from "../components/Layout";
import { storageClient } from "../lib/grove";
import { uri } from "@lens-protocol/client";
import { article } from "@lens-protocol/metadata";
import { post, fetchPost } from "@lens-protocol/client/actions";
import { handleOperationWith } from "@lens-protocol/client/viem";
import { useNostrIdentity } from "../hooks/useNostrIdentity";
import { useNostrRelay } from "../hooks/useNostrRelay";
import { buildImetaTags } from "../lib/nostrRelay";
import { useWalletClient } from "wagmi";
import { lensClient } from "../lib/lens";
import { useNavigate } from "react-router-dom";
import useUserInfo from "../hooks/useUserInfo";
import { useCountry } from "../hooks/useCountry";
import CreatePostModal from "../components/CreatePostModal"; // ADDED IMPORT
import {
  VIOLATION_CATEGORIES,
  getViolationTypeById,
  getSeverityLevelForType,
  getSeverityInfo,
} from "../config/violationTypes";
// ADDED: the shared publishing limit (1/min, 10/hr, 20/day) - the same
// counter used for regular posts/help requests/comments.
import { checkPostRateLimit } from "../utils/postRateLimit";

// ADDED: max length for a violation description. Higher than a regular
// post's 3000 (CreatePostModal.jsx) - a violation report is a formal,
// detailed account (what/where/when/circumstances/witnesses), not a
// casual update, so it gets more room: ~1000-1200 words.
const MAX_VIOLATION_DESCRIPTION_LENGTH = 6000;

const ViolationsPage = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { userInfo, loading: userLoading } = useUserInfo();
  const { signEvent: signNostrEvent } = useNostrIdentity();
  const { publishToNostr } = useNostrRelay();
  const { getAllCountries, getTranslatedCountryName } = useCountry(
    localStorage.getItem("i18nextLng") || "en",
  );
  // Separate English-only instance used ONLY for building Nominatim search
  // queries. Nominatim/OpenStreetMap indexes place names by their English
  // (or official) form, and localized short names (e.g. the Ukrainian
  // locale's short form "Сполучені Штати" ["United States"] instead of the
  // OSM-indexed full form "Сполучені Штати Америки" ["United States of
  // America"]) can make the geocoding query match nothing at all. Using
  // the English name here keeps geocoding reliable regardless of UI
  // language, while getTranslatedCountryName above is still used for
  // anything shown to the user (labels, dropdowns, etc.).
  const { getTranslatedCountryName: getEnglishCountryName } = useCountry("en");
  const { data: walletClient } = useWalletClient();

  // Form states
  const [formData, setFormData] = useState({
    country: "",
    address: "",
    categoryId: "",
    violationTypeId: "",
    violationDescription: "",
    violationDate: "",
    violationTime: "",
  });

  // ADDED: State for create post modal
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);

  // States for working with addresses
  const [addressSuggestions, setAddressSuggestions] = useState([]);
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);
  const [showAddressSuggestions, setShowAddressSuggestions] = useState(false);
  const [addressCoordinates, setAddressCoordinates] = useState(null);
  const [addressDetails, setAddressDetails] = useState(null);
  const [addressCountryMatch, setAddressCountryMatch] = useState(true); // NEW: checking country match

  // States for files
  const [files, setFiles] = useState([]);
  const [uploadProgress, setUploadProgress] = useState({});

  // Form states
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [validationErrors, setValidationErrors] = useState({});

  // Timer for address autocomplete
  const [searchTimeout, setSearchTimeout] = useState(null);

  // Set default country from user profile
  useEffect(() => {
    if (userInfo) {
      if (
        !formData.country &&
        userInfo.country &&
        userInfo.country !== "EARTH"
      ) {
        setFormData((prev) => ({ ...prev, country: userInfo.country }));
      }
    }
  }, [userInfo]);

  // Function to get country code from Nominatim address
  const getCountryCodeFromAddress = (address) => {
    if (!address || !address.address) return null;

    // Try to get country code from address object
    const addr = address.address;

    // Check various fields where country might be
    if (addr.country_code) {
      return addr.country_code.toUpperCase();
    }

    // If no country code, try to get country name
    if (addr.country) {
      // Simplified check - real app would need a country name-to-code dictionary
      const countryName = addr.country.toLowerCase();
      const allCountries = getAllCountries();
      const matchedCountry = allCountries.find(
        (c) =>
          c.name.toLowerCase() === countryName ||
          c.name.toLowerCase().includes(countryName) ||
          countryName.includes(c.name.toLowerCase()),
      );
      return matchedCountry ? matchedCountry.code : null;
    }

    return null;
  };

  // Address geocoding function
  const geocodeAddress = async (address, countryCode) => {
    try {
      // Use the English country name for the actual geocoding query — it
      // reliably matches how places are indexed in OpenStreetMap, unlike
      // some localized short names (see note near the useCountry("en") hook).
      const countryName = getEnglishCountryName(countryCode);
      const fullAddress =
        countryCode !== "EARTH" ? `${address}, ${countryName}` : address;

      // Get current language from i18n
      const currentLanguage = i18n.language || "en";
      // Priority: English, fallback to current app language
      const acceptLanguage = `en,${currentLanguage}`;

      // Add parameter to limit search to selected country
      const url =
        countryCode !== "EARTH"
          ? `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(fullAddress)}&limit=3&addressdetails=1&countrycodes=${countryCode.toLowerCase()}&accept-language=${acceptLanguage}`
          : `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(fullAddress)}&limit=3&addressdetails=1&accept-language=${acceptLanguage}`;

      const response = await fetch(url, {
        headers: {
          "User-Agent": "HumanRightsApp/1.0",
        },
      });

      if (!response.ok) {
        console.error(
          "❌ Geocoding API error:",
          response.status,
          response.statusText,
        );
        throw new Error(t("geocoding_failed") || "Geocoding error");
      }

      const data = await response.json();

      if (data && data.length > 0) {
        const result = data[0];

        // Check if address belongs to selected country
        const resultCountryCode = getCountryCodeFromAddress(result);
        if (
          countryCode !== "EARTH" &&
          resultCountryCode &&
          resultCountryCode !== countryCode
        ) {
          console.warn(
            "⚠️ Address country mismatch:",
            resultCountryCode,
            "expected:",
            countryCode,
          );
          throw new Error(
            t("address_country_mismatch") ||
              "Address does not belong to the selected country. Please check the address or select a different country.",
          );
        }

        const geocodedData = {
          latitude: parseFloat(result.lat),
          longitude: parseFloat(result.lon),
          city:
            result.address?.city ||
            result.address?.town ||
            result.address?.village ||
            null,
          region: result.address?.state || result.address?.region || null,
          postalCode: result.address?.postcode || null,
          displayName: result.display_name,
          countryCode: resultCountryCode,
        };

        return geocodedData;
      }

      console.warn("⚠️ No geocoding results found");
      throw new Error(
        t("address_not_found") ||
          "Address not found. Try entering a more specific address.",
      );
    } catch (error) {
      console.error("❌ Geocoding error:", error);
      throw error;
    }
  };

  // Search addresses on input
  const searchAddresses = useCallback(
    async (query, countryCode) => {
      if (query.length < 3) {
        setAddressSuggestions([]);
        return;
      }

      if (!countryCode) {
        setAddressSuggestions([]);
        setSubmitError(t("select_country_first") || "Select a country first");
        return;
      }

      setIsSearchingAddress(true);
      setSubmitError("");

      try {
        // English name here too, for the same reason as in geocodeAddress.
        const countryName = getEnglishCountryName(countryCode);
        const searchQuery =
          countryCode !== "EARTH" ? `${query}, ${countryName}` : query;

        // Get current language from i18n
        const currentLanguage = i18n.language || "en";
        // Priority: English, fallback to current app language
        const acceptLanguage = `en,${currentLanguage}`;

        // Add countrycodes parameter to limit search to selected country
        const url =
          countryCode !== "EARTH"
            ? `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=5&addressdetails=1&countrycodes=${countryCode.toLowerCase()}&accept-language=${acceptLanguage}`
            : `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=5&addressdetails=1&accept-language=${acceptLanguage}`;

        const response = await fetch(url, {
          headers: {
            "User-Agent": "HumanRightsApp/1.0",
          },
        });

        if (!response.ok) {
          throw new Error("Search failed");
        }

        const data = await response.json();

        // Filter results by country (additional check)
        const filteredResults =
          countryCode !== "EARTH"
            ? data.filter((result) => {
                const resultCountryCode = getCountryCodeFromAddress(result);
                return !resultCountryCode || resultCountryCode === countryCode;
              })
            : data;

        setAddressSuggestions(filteredResults);
      } catch (error) {
        console.error("Address search error:", error);
        setAddressSuggestions([]);
      } finally {
        setIsSearchingAddress(false);
      }
    },
    [getEnglishCountryName, t, i18n],
  );

  // Handle address change with debounce
  const handleAddressChange = (value) => {
    setFormData((prev) => ({ ...prev, address: value }));
    setShowAddressSuggestions(true);
    setAddressCoordinates(null);
    setAddressDetails(null);
    setAddressCountryMatch(true); // Reset previous check

    // Clear previous timer
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }

    // Set new timer
    const timeout = setTimeout(() => {
      if (value.length >= 3 && formData.country) {
        searchAddresses(value, formData.country);
      } else {
        setAddressSuggestions([]);
      }
    }, 500);

    setSearchTimeout(timeout);
  };

  // Select address from list
  const handleAddressSelect = (suggestion) => {
    // Check if address belongs to selected country
    const selectedCountryCode = getCountryCodeFromAddress(suggestion);
    const isCountryMatch =
      !formData.country ||
      formData.country === "EARTH" ||
      !selectedCountryCode ||
      selectedCountryCode === formData.country;

    if (!isCountryMatch) {
      setSubmitError(
        t("address_country_mismatch_select") ||
          "Selected address does not belong to the selected country. Please choose a different address or change the country.",
      );
      setAddressCountryMatch(false);
      return;
    }

    setFormData((prev) => ({ ...prev, address: suggestion.display_name }));
    setAddressCoordinates({
      latitude: parseFloat(suggestion.lat),
      longitude: parseFloat(suggestion.lon),
    });
    setAddressDetails({
      city:
        suggestion.address.city ||
        suggestion.address.town ||
        suggestion.address.village ||
        null,
      region: suggestion.address.state || suggestion.address.region || null,
      postalCode: suggestion.address.postcode || null,
      countryCode: selectedCountryCode,
    });
    setAddressCountryMatch(true);
    setShowAddressSuggestions(false);
    setAddressSuggestions([]);
    setSubmitError(""); // Clear errors on successful selection
  };

  // Handle country change
  const handleCountryChange = (countryCode) => {
    setFormData((prev) => ({
      ...prev,
      country: countryCode,
      address: "", // Clear address when changing country
    }));
    setAddressCoordinates(null);
    setAddressDetails(null);
    setAddressSuggestions([]);
    setShowAddressSuggestions(false);
    setAddressCountryMatch(true);
    setSubmitError("");
  };

  // Handle files
  const handleFileChange = (e) => {
    const selectedFiles = Array.from(e.target.files);
    const validFiles = [];
    const errors = [];

    selectedFiles.forEach((file) => {
      // Check file type
      const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "video/mp4",
        "video/webm",
        "application/pdf",
      ];

      if (!allowedTypes.includes(file.type)) {
        errors.push(
          `${file.name}: ${t("unsupported_file_type") || "Unsupported file type"}`,
        );
        return;
      }

      // Check size (20MB)
      if (file.size > 20 * 1024 * 1024) {
        errors.push(
          `${file.name}: ${t("file_too_large") || "File is too large (max 20MB)"}`,
        );
        return;
      }

      validFiles.push(file);
    });

    if (errors.length > 0) {
      setSubmitError(errors.join("; "));
    }

    setFiles((prev) => [...prev, ...validFiles]);
  };

  // Remove file
  const handleRemoveFile = (index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // Uploading files to Grove Storage
  const uploadFilesToGrove = async () => {
    const uploadedAttachments = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        setUploadProgress((prev) => ({ ...prev, [i]: 10 }));

        const { uri: fileUri, gatewayUrl } = await storageClient.uploadFile(
          file,
        );

        const getType = (mime) => {
          if (mime.startsWith("image/")) return "Image";
          if (mime.startsWith("video/")) return "Video";
          return "Image";
        };

        uploadedAttachments.push({
          item: fileUri,
          // ADDED: kept alongside item (the lens://... URI Lens
          // metadata needs) specifically so the Nostr cross-post below
          // can link to the actual resolvable https:// file — Nostr
          // clients can't resolve lens:// at all.
          gatewayUrl,
          type: file.type,
          altTag: file.name,
        });

        setUploadProgress((prev) => ({ ...prev, [i]: 100 }));
      } catch (error) {
        console.error(`Error uploading ${file.name}:`, error);
        throw new Error(`Failed to upload file: ${file.name}`);
      }
    }

    return uploadedAttachments;
  };

  // Uploading metadata to Grove
  const uploadMetadataToGrove = async (metadata) => {
    const { uri: metadataUri } = await storageClient.uploadAsJson(metadata);
    return metadataUri;
  };

  // Form validation
  const validateForm = () => {
    const errors = {};

    if (!formData.country) {
      errors.country = t("country_required") || "Country is required";
    }

    if (!formData.address || formData.address.length < 5) {
      errors.address =
        t("address_required") || "Address is required (min. 5 characters)";
    }

    if (!formData.categoryId || !formData.violationTypeId) {
      errors.violationTypeId =
        t("violation_type_required") || "Please select the type of violation";
    }

    // CHANGED: dropped the "min. 20 characters" requirement per request —
    // it read as clunky/arbitrary; just requires non-empty now. The upper
    // bound (MAX_VIOLATION_DESCRIPTION_LENGTH) is enforced below instead.
    if (!formData.violationDescription.trim()) {
      errors.violationDescription =
        t("violation_description_required") ||
        "Violation description is required";
    } else if (
      formData.violationDescription.length > MAX_VIOLATION_DESCRIPTION_LENGTH
    ) {
      errors.violationDescription =
        t("violation_description_too_long", {
          max: MAX_VIOLATION_DESCRIPTION_LENGTH,
        }) ||
        `Description is too long (max ${MAX_VIOLATION_DESCRIPTION_LENGTH} characters)`;
    }

    if (formData.violationDate) {
      const selectedDate = new Date(formData.violationDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (selectedDate > today) {
        errors.violationDate =
          t("date_cannot_be_future") || "Date cannot be in the future";
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Submit form
  const handleSubmit = async (e) => {
    e.preventDefault();

    // Additional country match check before submission
    if (
      formData.country &&
      formData.country !== "EARTH" &&
      addressDetails?.countryCode
    ) {
      if (addressDetails.countryCode !== formData.country) {
        setSubmitError(
          t("address_country_mismatch_final") ||
            "Address does not belong to the selected country. Please check the entered data.",
        );
        return;
      }
    }

    if (!validateForm()) {
      setSubmitError(
        t("form_validation_failed") || "Please fix errors in the form",
      );
      return;
    }

    // ADDED: the shared publishing limit - checked FIRST, before
    // geocoding and uploading files to Grove, so as not to make the user
    // wait for heavy work that will be rejected anyway.
    const myAddressForLimit =
      localStorage.getItem("lens_account_address") ||
      walletClient?.account?.address ||
      localStorage.getItem("lens_wallet_address") ||
      null;
    const rateCheck = await checkPostRateLimit(
      myAddressForLimit,
      formData.violationDescription,
    );
    if (!rateCheck.allowed) {
      setSubmitError(rateCheck.reason);
      return;
    }

    setIsSubmitting(true);
    setSubmitError("");

    try {
      // Geocode address if coordinates not yet obtained
      let coordinates = addressCoordinates;
      let details = addressDetails;

      if (!coordinates) {
        try {
          const geocoded = await geocodeAddress(
            formData.address,
            formData.country,
          );
          coordinates = {
            latitude: geocoded.latitude,
            longitude: geocoded.longitude,
          };
          details = {
            city: geocoded.city,
            region: geocoded.region,
            postalCode: geocoded.postalCode,
            countryCode: geocoded.countryCode,
          };
        } catch (geocodeError) {
          console.error("❌ Geocoding failed:", geocodeError);

          // If geocoding fails, ask user to fix the address
          setSubmitError(
            t("geocoding_failed_message") ||
              "Unable to find the specified address. Please select an address from the suggestions list or enter a more precise address (e.g., include street name, house number, and city).",
          );
          setIsSubmitting(false);
          return;
        }
      }

      // Verify coordinates were obtained
      if (!coordinates || !coordinates.latitude || !coordinates.longitude) {
        throw new Error(
          t("coordinates_required") ||
            "Unable to determine address coordinates. Try selecting an address from the suggestions list.",
        );
      }

      // 1. First upload the files to Grove
      let attachments = [];
      if (files.length > 0) {
        attachments = await uploadFilesToGrove();
      }

      // 2. Build metadata according to the Step 1 schema
      const violationDateTime =
        formData.violationDate && formData.violationTime
          ? `${formData.violationDate}T${formData.violationTime}:00Z`
          : formData.violationDate
            ? `${formData.violationDate}T00:00:00Z`
            : null;

      const violationMetadata = article({
        title: formData.violationDescription.substring(0, 100),
        content: formData.violationDescription,
        // Only pass the attachments key if there's at least one file —
        // the Lens schema validates attachments as .optional().min(1), so
        // an empty array [] fails validation, while omitting the key does not.
        ...(attachments.length > 0 ? { attachments } : {}),
        tags: ["violation", "human-rights", "hrpdao", formData.country],
        attributes: [
          { key: "type", value: "violation", type: "String" },
          { key: "countryCode", value: formData.country, type: "String" },
          { key: "address", value: formData.address, type: "String" },
          {
            key: "latitude",
            value: String(coordinates.latitude),
            type: "String",
          },
          {
            key: "longitude",
            value: String(coordinates.longitude),
            type: "String",
          },
          { key: "city", value: details?.city || "", type: "String" },
          { key: "region", value: details?.region || "", type: "String" },
          {
            key: "violationDate",
            value: violationDateTime || "",
            type: "String",
          },
          {
            key: "categoryId",
            value: formData.categoryId,
            type: "String",
          },
          {
            key: "violationTypeId",
            value: formData.violationTypeId,
            type: "String",
          },
          {
            key: "severityLevel",
            value: String(getSeverityLevelForType(formData.violationTypeId)),
            type: "String",
          },
          { key: "isAnonymous", value: "false", type: "String" },
          { key: "app", value: "hrpdao", type: "String" },
        ].filter((a) => a.value !== ""), // remove attributes with an empty value
      });

      // 3. Upload metadata to Grove
      const metadataUri = await uploadMetadataToGrove(violationMetadata);

      // 4. Publish the post on Lens
      const sessionResumed = await lensClient.resumeSession();
      if (sessionResumed.isErr()) {
        throw new Error("Lens session not found. Please login again.");
      }
      const sessionClient = sessionResumed.value;

      const result = await post(sessionClient, {
        contentUri: uri(metadataUri),
      }).andThen(handleOperationWith(walletClient));

      if (result.isErr()) {
        throw new Error(result.error.message);
      }

      const txHash = result.value;

      // ADDED: best-effort Nostr cross-post — isolated in its own
      // try/catch, never blocks or reverts the Lens violation report
      // above, which has already succeeded regardless. Content here
      // is deliberately more detailed than a regular post's cross-post
      // (title, location, category, date) since a violation report's
      // core value IS that structured detail — a bare one-line note
      // would lose most of what makes the report useful.
      let nostrResult = null;
      try {
        const violationResult = await fetchPost(lensClient, { txHash });
        const lensViolationId = violationResult.isOk()
          ? violationResult.value?.id
          : null;
        const postUrl =
          typeof window !== "undefined" && lensViolationId
            ? `${window.location.origin}/violations/${lensViolationId}`
            : null;

        const mediaLinks = (attachments || [])
          .map((a) => a.gatewayUrl)
          .filter(Boolean);
        const noteContent = [
          `🚨 Human rights violation reported`,
          formData.violationDescription,
          details?.city || details?.region
            ? `📍 ${[details?.city, details?.region, formData.country].filter(Boolean).join(", ")}`
            : null,
          violationDateTime ? `🕒 ${violationDateTime}` : null,
          ...mediaLinks,
          postUrl,
        ]
          .filter(Boolean)
          .join("\n\n");

        const nostrEvent = await signNostrEvent({
          kind: 1,
          content: noteContent,
          tags: [
            ["t", "hrpdao"],
            ["t", "violation"],
            ["t", "human-rights"],
            ["t", formData.country],
            ...buildImetaTags(attachments),
            ...(postUrl ? [["r", postUrl]] : []),
          ],
        });

        if (nostrEvent) {
          const relayResults = await publishToNostr(nostrEvent);
          nostrResult = {
            success: relayResults.some((r) => r.ok),
            relays: relayResults,
          };
          console.log("✅ Violation cross-posted to Nostr:", nostrResult);
        }
      } catch (nostrErr) {
        console.warn(
          "⚠️ Nostr cross-post failed for violation (Lens report is unaffected):",
          nostrErr.message,
        );
      }

      setSubmitSuccess(true);

      // Clear form and redirect
      setTimeout(() => {
        navigate("/violations-list");
      }, 2000);
    } catch (error) {
      console.error("❌ Error submitting violation:", error);
      setSubmitError(
        error.message ||
          t("submit_failed") ||
          "Error submitting violation. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // Get maximum date (today)
  const getMaxDate = () => {
    const today = new Date();
    return today.toISOString().split("T")[0];
  };

  if (userLoading) {
    return (
      <Layout
        userProfile={userInfo}
        onLogout={() => {}}
        loading={true}
        onCreatePost={() => setShowCreatePostModal(true)} // ADDED
      >
        <div className="min-h-screen flex items-center justify-center">
          <div className="w-8 h-8 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin" />
        </div>
      </Layout>
    );
  }

  if (!userInfo) {
    return (
      <Layout
        userProfile={null}
        onLogout={() => {}}
        onCreatePost={() => setShowCreatePostModal(true)} // ADDED
      >
        <div className="min-h-screen flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-6 text-center max-w-xs">
            <AlertCircle className="w-8 h-8 text-red-400/50 mx-auto mb-3" />
            <p className="text-[14px] text-slate-600 dark:text-white/40 mb-4">
              {t("please_login") || "Please login to submit a violation"}
            </p>
            <button
              onClick={() => navigate("/")}
              className="px-4 py-2 rounded-lg bg-[#2B000A] border border-[#b41e3c]/30 text-[#e8a0b0]/80 text-[14px] font-medium hover:bg-[#3d0012] transition-colors"
            >
              {t("go_to_login") || "Login"}
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout
      userProfile={userInfo}
      onLogout={() => {
        localStorage.removeItem("token");
        localStorage.removeItem("web3_wallet_address");
        window.location.href = "/";
      }}
      loading={userLoading}
      onCreatePost={() => setShowCreatePostModal(true)} // ADDED
    >
      {/* ADDED: Create post modal window */}
      {showCreatePostModal && userInfo && (
        <div className="h-full">
          <CreatePostModal
            onClose={() => setShowCreatePostModal(false)}
            userCountry={userInfo?.country || "EARTH"}
          />
        </div>
      )}

      {/* Main page - displayed only if create post modal is not open */}
      {!showCreatePostModal && (
        <div className="max-w-2xl xl:max-w-3xl mx-auto pt-3 pb-3 px-0 lg:p-4">
          {/* Header with title and navigation buttons */}
          <div className="mb-5 pb-4 border-b border-slate-300 dark:border-white/[0.06] flex items-start justify-between">
            <div>
              <h1 className="font-cinzel text-[19px] font-medium text-slate-900 dark:text-white/85 tracking-[0.04em] flex items-center gap-2">
                {t("submit_violation") || "Submit Violation"}
              </h1>
            </div>

            {/* Navigation links - moved to right side */}
            <div className="flex flex-wrap gap-2 flex-shrink-0 ml-4">
              <button
                onClick={() => navigate("/violations-map")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] border border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-600 dark:text-white/40 hover:border-slate-300 dark:hover:border-white/[0.16] hover:text-slate-700 dark:text-white/65 transition-all"
              >
                <MapIcon className="w-3 h-3" />
                {t("violations_map") || "Map"}
              </button>
              <button
                onClick={() => navigate("/violations-list")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] border border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-600 dark:text-white/40 hover:border-slate-300 dark:hover:border-white/[0.16] hover:text-slate-700 dark:text-white/65 transition-all"
              >
                <List className="w-3 h-3" />
                {t("violations_list") || "List"}
              </button>
            </div>
          </div>

          {/* Success message */}
          {submitSuccess && (
            <div className="mb-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-emerald-400/80 flex-shrink-0" />
              <div>
                <p className="text-[14px] font-medium text-emerald-400/90">
                  {t("violation_submitted_success") ||
                    "Violation submitted successfully!"}
                </p>
                <p className="text-[14px] text-emerald-400/60 mt-0.5">
                  {t("redirecting_to_list") || "Redirecting..."}
                </p>
              </div>
            </div>
          )}

          {/* Error message */}
          {submitError && (
            <div className="mb-4 p-3 rounded-xl bg-red-900/15 border border-red-800/25 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-400/75 flex-shrink-0" />
              <p className="text-[14px] text-red-400/80">{submitError}</p>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-3">
            {/* Unified card: all fields in one dark-blue area,
                separated by a thin line instead of separate boxes */}
            <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl divide-y divide-slate-200 dark:divide-white/[0.07] overflow-hidden">
              {/* Location: Country + Address */}
              <div className="p-4 space-y-4">
                {/* Country */}
                <div>
                  <label className="block text-[14px] font-medium text-slate-700 dark:text-white/45 mb-1.5">
                    {t("country") || "Country"}{" "}
                    <span className="text-red-400/70">*</span>
                  </label>
                  <select
                    value={formData.country}
                    onChange={(e) => handleCountryChange(e.target.value)}
                    className={`w-full h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border ${
                      validationErrors.country
                        ? "border-red-500/40"
                        : "border-slate-300 dark:border-white/[0.09]"
                    } rounded-lg text-[14px] text-slate-600 dark:text-white/65 font-['Inter'] outline-none focus:border-blue-500/35 transition-all appearance-none`}
                  >
                    <option value="" className="bg-white dark:bg-[#000d1f]">
                      {t("select_country") || "Select country"}
                    </option>
                    {getAllCountries().map((country) => (
                      <option
                        key={country.code}
                        value={country.code}
                        className="bg-white dark:bg-[#000d1f]"
                      >
                        {country.name}
                      </option>
                    ))}
                  </select>
                  {validationErrors.country && (
                    <p className="mt-1 text-[14px] text-red-400/70">
                      {validationErrors.country}
                    </p>
                  )}
                  {formData.country && (
                    <p className="mt-1.5 text-[14px] text-slate-600 dark:text-white/40">
                      {t("address_search_will_be_limited") ||
                        "Address search will be limited to the selected country"}
                    </p>
                  )}
                </div>

                {/* Address */}
                <div>
                  <label className="block text-[14px] font-medium text-slate-700 dark:text-white/45 mb-1.5">
                    <MapPin className="w-3.5 h-3.5 inline mr-1 text-slate-600 dark:text-white/40" />
                    {t("violation_address") || "Violation address"}{" "}
                    <span className="text-red-400/70">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={formData.address}
                      onChange={(e) => handleAddressChange(e.target.value)}
                      placeholder={
                        formData.country
                          ? (
                              t("address_placeholder_with_country") ||
                              "Enter address in {country}..."
                            ).replace(
                              "{country}",
                              getTranslatedCountryName(formData.country),
                            )
                          : t("address_placeholder_select_country") ||
                            "First select a country"
                      }
                      className={`w-full h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border ${
                        validationErrors.address
                          ? "border-red-500/40"
                          : "border-slate-300 dark:border-white/[0.09]"
                      } rounded-lg text-[14px] text-slate-600 dark:text-white/65 placeholder-slate-300 dark:placeholder-white/[0.18] font-['Inter'] outline-none focus:border-blue-500/35 transition-all disabled:opacity-40`}
                      disabled={!formData.country}
                    />
                    {isSearchingAddress && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2">
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin" />
                      </div>
                    )}

                    {/* Address suggestions */}
                    {showAddressSuggestions &&
                      addressSuggestions.length > 0 && (
                        <div className="absolute z-10 w-full mt-1 bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.09] rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.5)] max-h-48 overflow-y-auto">
                          {addressSuggestions.map((suggestion, index) => {
                            const suggestionCountryCode =
                              getCountryCodeFromAddress(suggestion);
                            const isSameCountry =
                              !formData.country ||
                              formData.country === "EARTH" ||
                              !suggestionCountryCode ||
                              suggestionCountryCode === formData.country;

                            return (
                              <button
                                key={index}
                                type="button"
                                onClick={() => handleAddressSelect(suggestion)}
                                className={`w-full px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-white/[0.05] border-b border-slate-100 dark:border-white/[0.05] last:border-b-0 transition-colors ${
                                  !isSameCountry ? "bg-amber-500/[0.06]" : ""
                                }`}
                              >
                                <p className="text-[14px] text-slate-600 dark:text-white/65">
                                  {suggestion.display_name}
                                </p>
                                {suggestionCountryCode && (
                                  <p className="text-[14px] mt-0.5 text-slate-600 dark:text-white/40">
                                    {getTranslatedCountryName(
                                      suggestionCountryCode,
                                    )}
                                    {!isSameCountry && (
                                      <span className="ml-1 text-amber-400/70">
                                        (
                                        {t("different_country") ||
                                          "different country"}
                                        )
                                      </span>
                                    )}
                                  </p>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                  </div>
                  {validationErrors.address && (
                    <p className="mt-1 text-[14px] text-red-400/70">
                      {validationErrors.address}
                    </p>
                  )}
                  {addressCoordinates && addressCountryMatch && (
                    <p className="mt-1.5 text-[14px] text-emerald-400/75 flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" />
                      {t("address_validated") || "Address validated"}
                    </p>
                  )}
                  {addressCoordinates && !addressCountryMatch && (
                    <p className="mt-1.5 text-[14px] text-red-400/75 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {t("address_country_mismatch_warning") ||
                        "Address does not match selected country!"}
                    </p>
                  )}
                  {!formData.country && formData.address && (
                    <p className="mt-1.5 text-[14px] text-amber-400/70">
                      {t("select_country_to_validate") ||
                        "Select country to validate address"}
                    </p>
                  )}
                </div>
              </div>

              {/* Violation type: category + specific type (required).
                Severity is NEVER entered manually — it's automatically
                derived from the selected violationTypeId (see config/violationTypes.js). */}
              <div className="p-4 space-y-4">
                <div>
                  <label className="block text-[14px] font-medium text-slate-700 dark:text-white/45 mb-1.5">
                    {t("violation_category") || "Category"}{" "}
                    <span className="text-red-400/70">*</span>
                  </label>
                  <select
                    value={formData.categoryId}
                    onChange={(e) => {
                      const categoryId = e.target.value;
                      setFormData((prev) => ({
                        ...prev,
                        categoryId,
                        // Reset the specific type when the category changes — the
                        // old selection may not belong to the new category.
                        violationTypeId: "",
                      }));
                    }}
                    className="w-full h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-600 dark:text-white/65 font-['Inter'] outline-none focus:border-blue-500/35 transition-all appearance-none"
                    style={{
                      backgroundImage: `url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22rgba(255%2C255%2C255%2C0.25)%22%20stroke-width%3D%222%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%2F%3E%3C%2Fsvg%3E')`,
                      backgroundPosition: "right 10px center",
                      backgroundRepeat: "no-repeat",
                      paddingRight: "30px",
                    }}
                  >
                    <option value="" className="bg-white dark:bg-[#000d1f]">
                      {t("select_category") || "Select category"}
                    </option>
                    {VIOLATION_CATEGORIES.map((category) => (
                      <option
                        key={category.id}
                        value={category.id}
                        className="bg-white dark:bg-[#000d1f]"
                      >
                        {t(category.labelKey) || category.label}
                      </option>
                    ))}
                  </select>
                </div>

                {formData.categoryId && (
                  <div>
                    <label className="block text-[14px] font-medium text-slate-700 dark:text-white/45 mb-1.5">
                      {t("violation_type") || "Specific violation"}{" "}
                      <span className="text-red-400/70">*</span>
                    </label>
                    <select
                      value={formData.violationTypeId}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          violationTypeId: e.target.value,
                        }))
                      }
                      className="w-full h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-600 dark:text-white/65 font-['Inter'] outline-none focus:border-blue-500/35 transition-all appearance-none"
                      style={{
                        backgroundImage: `url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22rgba(255%2C255%2C255%2C0.25)%22%20stroke-width%3D%222%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%2F%3E%3C%2Fsvg%3E')`,
                        backgroundPosition: "right 10px center",
                        backgroundRepeat: "no-repeat",
                        paddingRight: "30px",
                      }}
                    >
                      <option value="" className="bg-white dark:bg-[#000d1f]">
                        {t("select_violation_type") || "Select specific type"}
                      </option>
                      {VIOLATION_CATEGORIES.find(
                        (c) => c.id === formData.categoryId,
                      )?.types.map((type) => (
                        <option
                          key={type.id}
                          value={type.id}
                          className="bg-white dark:bg-[#000d1f]"
                        >
                          {t(type.labelKey) || type.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Badge showing the calculated severity — shown for
                  transparency, but it's just a result, not a separate input field. */}
                {formData.violationTypeId &&
                  (() => {
                    const severity = getSeverityInfo(
                      getSeverityLevelForType(formData.violationTypeId),
                    );
                    return (
                      <div className="flex items-center gap-2 text-[14px]">
                        <span className="text-slate-600 dark:text-white/40">
                          {t("calculated_severity") || "Calculated severity:"}
                        </span>
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-medium"
                          style={{
                            backgroundColor: `${severity.color}1a`,
                            color: severity.color,
                          }}
                        >
                          <span>{severity.emoji}</span>
                          {t(severity.labelKey) || severity.label}
                        </span>
                      </div>
                    );
                  })()}

                {validationErrors.violationTypeId && (
                  <p className="text-[14px] text-red-400/70">
                    {validationErrors.violationTypeId}
                  </p>
                )}
              </div>

              {/* Violation description */}
              <div className="p-4">
                <label className="block text-[14px] font-medium text-slate-700 dark:text-white/45 mb-1.5">
                  {t("violation_description") || "Violation description"}{" "}
                  <span className="text-red-400/70">*</span>
                </label>
                <textarea
                  value={formData.violationDescription}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      violationDescription: e.target.value,
                    }))
                  }
                  placeholder={
                    t("violation_description_placeholder") ||
                    "Describe in detail what happened..."
                  }
                  rows={4}
                  maxLength={MAX_VIOLATION_DESCRIPTION_LENGTH}
                  className={`w-full px-3 py-2 bg-slate-50 dark:bg-white/[0.03] border ${
                    validationErrors.violationDescription
                      ? "border-red-500/40"
                      : "border-slate-300 dark:border-white/[0.09]"
                  } rounded-lg text-[14px] text-slate-600 dark:text-white/65 placeholder-slate-300 dark:placeholder-white/[0.18] font-['Inter'] outline-none focus:border-blue-500/35 transition-all resize-none`}
                />
                <div className="flex justify-between items-center mt-1.5">
                  {validationErrors.violationDescription && (
                    <p className="text-[14px] text-red-400/70">
                      {validationErrors.violationDescription}
                    </p>
                  )}
                  {/* CHANGED: dropped the "N / 20 min." counter (tied to
                      the removed minimum) — now shows "N / 6000" against
                      the upper bound instead, same escalating-color
                      pattern as the other content-length counters. */}
                  <p
                    className={`ml-auto text-[14px] ${
                      formData.violationDescription.length >=
                      MAX_VIOLATION_DESCRIPTION_LENGTH
                        ? "text-red-500 dark:text-red-400/80 font-medium"
                        : formData.violationDescription.length >=
                            MAX_VIOLATION_DESCRIPTION_LENGTH * 0.9
                          ? "text-amber-500 dark:text-amber-400/80"
                          : "text-slate-600 dark:text-white/40"
                    }`}
                  >
                    {formData.violationDescription.length} /{" "}
                    {MAX_VIOLATION_DESCRIPTION_LENGTH}
                  </p>
                </div>
              </div>

              {/* Optional fields */}
              <div className="p-4">
                <h3 className="font-cinzel text-[11px] text-slate-600 dark:text-white/40 tracking-[0.12em] uppercase mb-3">
                  {t("optional_information") || "Additional information"}
                </h3>

                <div className="space-y-3">
                  {/* Date and time */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[14px] font-medium text-slate-700 dark:text-white/45 mb-1.5">
                        <Calendar className="w-3.5 h-3.5 inline mr-1 text-slate-600 dark:text-white/40" />
                        {t("violation_date_label") || "Date"}
                      </label>
                      <input
                        type="date"
                        value={formData.violationDate}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            violationDate: e.target.value,
                          }))
                        }
                        max={getMaxDate()}
                        className={`w-full h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border ${
                          validationErrors.violationDate
                            ? "border-red-500/40"
                            : "border-slate-300 dark:border-white/[0.09]"
                        } rounded-lg text-[14px] text-slate-600 dark:text-white/65 font-['Inter'] outline-none focus:border-blue-500/35 transition-all`}
                      />
                      {validationErrors.violationDate && (
                        <p className="mt-1 text-[14px] text-red-400/70">
                          {validationErrors.violationDate}
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-[14px] font-medium text-slate-700 dark:text-white/45 mb-1.5">
                        {t("violation_time") || "Time"}
                      </label>
                      <input
                        type="time"
                        value={formData.violationTime}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            violationTime: e.target.value,
                          }))
                        }
                        className="w-full h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-600 dark:text-white/65 font-['Inter'] outline-none focus:border-blue-500/35 transition-all"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Evidence (files) */}
              <div className="p-4">
                <label className="block text-[14px] font-medium text-slate-700 dark:text-white/45 mb-1">
                  <Upload className="w-3.5 h-3.5 inline mr-1 text-slate-600 dark:text-white/40" />
                  {t("evidence_files_label") || "Evidence"}
                </label>
                <p className="text-[14px] text-slate-600 dark:text-white/40 mb-3">
                  {t("evidence_files_description") ||
                    "Photos, videos or documents (max. 20MB)."}
                </p>

                {/* Upload button */}
                <label className="cursor-pointer">
                  <input
                    type="file"
                    multiple
                    accept="image/*,video/*,application/pdf"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  <div className="flex items-center justify-center w-full px-3 py-5 border-2 border-dashed border-slate-300 dark:border-white/[0.12] rounded-xl bg-slate-50 dark:bg-white/[0.02] hover:border-[#b41e3c]/40 transition-colors">
                    <div className="text-center">
                      <Upload className="w-5 h-5 text-slate-600 dark:text-white/40 mx-auto mb-1.5" />
                      <p className="text-[14px] text-slate-600 dark:text-white/40">
                        {t("click_to_upload") || "Click to upload"}
                      </p>
                    </div>
                  </div>
                </label>

                {/* Uploaded files list */}
                {files.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {files.map((file, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-2.5 bg-slate-50 dark:bg-white/[0.025] border border-slate-300 dark:border-white/[0.07] rounded-xl"
                      >
                        <div className="flex items-center gap-2.5 flex-1 min-w-0">
                          <div className="flex-shrink-0">
                            {file.type.startsWith("image/") && (
                              <img
                                src={URL.createObjectURL(file)}
                                alt={file.name}
                                className="w-8 h-8 object-cover rounded-lg"
                              />
                            )}
                            {file.type.startsWith("video/") && (
                              <div className="w-8 h-8 bg-blue-900/20 border border-blue-700/20 rounded-lg flex items-center justify-center">
                                <FileText className="w-4 h-4 text-blue-400/70" />
                              </div>
                            )}
                            {file.type === "application/pdf" && (
                              <div className="w-8 h-8 bg-red-900/20 border border-red-700/20 rounded-lg flex items-center justify-center">
                                <FileText className="w-4 h-4 text-red-400/70" />
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[14px] text-slate-600 dark:text-white/65 truncate">
                              {file.name}
                            </p>
                            <p className="text-[14px] text-slate-600 dark:text-white/40">
                              {(file.size / 1024 / 1024).toFixed(2)} MB
                            </p>
                            {uploadProgress[index] !== undefined && (
                              <div className="mt-1 w-full bg-slate-200 dark:bg-white/[0.06] rounded-full h-1">
                                <div
                                  className="bg-blue-500/60 h-1 rounded-full transition-all"
                                  style={{ width: `${uploadProgress[index]}%` }}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveFile(index)}
                          className="flex-shrink-0 ml-2 w-6 h-6 rounded-lg flex items-center justify-center text-slate-600 dark:text-white/40 hover:text-red-400/75 hover:bg-red-500/[0.08] transition-all"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => navigate("/violations-list")}
                disabled={isSubmitting}
                className="px-4 py-2 rounded-lg text-[14px] bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] text-slate-600 dark:text-white/35 hover:border-slate-400 dark:hover:border-white/[0.15] hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("cancel") || "Cancel"}
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 rounded-lg text-[14px] font-medium
                bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35
                dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:hover:bg-[#3D0012] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {isSubmitting ? (
                  <>
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-current/30 border-t-current animate-spin" />
                    {t("submitting") || "Submitting..."}
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-3.5 h-3.5" />
                    {t("submit_violation") || "Submit"}
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}
    </Layout>
  );
};

export default ViolationsPage;