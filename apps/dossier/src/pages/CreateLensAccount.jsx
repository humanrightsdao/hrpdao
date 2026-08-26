// pages/CreateLensAccount.jsx
import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useWalletClient, useAccount } from "wagmi";
import { lensClient } from "../lib/lens";
import {
  createAccountWithUsername,
  canCreateUsername,
  fetchAccount,
} from "@lens-protocol/client/actions";
import { account, MetadataAttributeType } from "@lens-protocol/metadata";
import {
  signMessageWith,
  handleOperationWith,
} from "@lens-protocol/client/viem";
import { storageClient } from "../lib/grove";
import { useLensAuth } from "../context/LensAuthContext";
import { useCountry } from "../hooks/useCountry";
import { Globe, MapPin, Loader } from "lucide-react";
// ADDED: a real CAPTCHA (Cloudflare Turnstile, server-side verification) -
// specifically here, on actual account creation, not just in the
// educational test on Onboarding.jsx (that one is checked in the browser
// and doesn't protect against bots).
import CaptchaGate from "../components/CaptchaGate";

// How many ms to wait after the last keystroke,
// before making a request to check username uniqueness
const USERNAME_CHECK_DEBOUNCE_MS = 500;

export default function CreateLensAccount() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const {
    setExternalSessionClient,
    fetchAccounts: fetchExistingAccounts,
    // FIXED (see ensureOnboardingSession below): renamed to avoid
    // clashing with this component's own local `sessionClient` state.
    // The context's sessionClient is the one set earlier by
    // App.jsx → loginAsOnboardingUser() when the user clicked "Create
    // Lens account" on the login screen — reusing it here avoids
    // asking MetaMask for a second, completely redundant signature.
    sessionClient: contextSessionClient,
  } = useLensAuth();
  const {
    getTranslatedCountryName,
    detectLocation,
    loading: countryLoading,
  } = useCountry();

  const [formData, setFormData] = useState({
    unique_name: "",
    country: "EARTH",
    h3Index: null,
  });

  const [formErrors, setFormErrors] = useState({});
  const [usernameStatus, setUsernameStatus] = useState("idle");
  // idle | checking | available | taken | invalid | error
  const [usernameMessage, setUsernameMessage] = useState("");

  const [sessionClient, setSessionClient] = useState(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  // If the connected wallet already has a Lens account — block the form
  // entirely (the "one wallet — one account" rule applies).
  const [walletAlreadyHasAccount, setWalletAlreadyHasAccount] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitStage, setSubmitStage] = useState(""); // signing | confirming | finishing
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Confirming age 18+, the privacy policy, and terms — required before
  // creating an account, since isAdult/hasAcceptedTerms are written into
  // the on-chain metadata. Without this flag the button is blocked.
  const [termsAccepted, setTermsAccepted] = useState(false);
  // ADDED: true only after /verify-captcha (a Cloudflare Pages Function)
  // has confirmed the Turnstile token via SERVER-SIDE verification - see
  // CaptchaGate.jsx.
  // TEMPORARY DEV BYPASS: /verify-captcha is a Cloudflare Pages
  // Function — it only exists once deployed to Cloudflare Pages,
  // there's no such endpoint under plain `npm run dev` (Vite's own
  // dev server, no Pages Functions runtime). So the Turnstile widget
  // itself can pass ("Успіх!"), but the follow-up server-side
  // verification POST 404s/fails, and captchaVerified never flips —
  // blocking account creation locally even with a valid human token.
  // import.meta.env.DEV is Vite's own built-in flag: true only under
  // `npm run dev`, always false in a production build (`npm run
  // build`) — so this bypass cannot accidentally ship to production.
  // REMOVE this override once /verify-captcha is actually reachable
  // in your local setup (e.g. testing via `wrangler pages dev`
  // instead of plain `vite dev`), or once you're satisfied local
  // testing doesn't need to re-exercise the CAPTCHA path.
  const [captchaVerified, setCaptchaVerified] = useState(
    import.meta.env.DEV,
  );
  const handleTermsAccept = (checked) => {
    setTermsAccepted(checked);
    if (checked) {
      localStorage.setItem("terms_accepted_at", new Date().toISOString());
    } else {
      localStorage.removeItem("terms_accepted_at");
    }
  };

  const debounceRef = useRef(null);
  const currentLanguage = i18n.language;

  // ADDED: refs for the cleanup effect below, which revokes the
  // onboarding session if the user leaves the page without ever creating
  // an account (see the useEffect with cleanup at the end of the
  // ensureOnboardingSession block below).
  const sessionClientRef = useRef(null);
  useEffect(() => {
    sessionClientRef.current = sessionClient;
  }, [sessionClient]);
  const accountCreatedRef = useRef(false);

  // If the component unmounts (the user left the page — e.g. clicked
  // "back" to onboarding) and the account was never created — revoke the
  // onboarding session. Without this, the token would remain valid in the
  // Lens SDK's storage and "come back to life" on the next
  // lensClient.resumeSession() in LensAuthContext, causing the app to
  // load endlessly.
  useEffect(() => {
    return () => {
      if (sessionClientRef.current && !accountCreatedRef.current) {
        sessionClientRef.current.logout().catch((err) => {
          console.warn(
            "⚠️ Failed to revoke the unfinished onboarding session:",
            err.message,
          );
        });
      }
    };
  }, []);

  // === Logging in as onboardingUser is needed ahead of time,
  // since canCreateUsername requires an authorized session ===
  useEffect(() => {
    let cancelled = false;

    const ensureOnboardingSession = async () => {
      if (!walletClient || !address || sessionClient) return;

      setSessionLoading(true);

      // === "One wallet — one Lens account" safeguard ===
      // This page is directly accessible at the URL /create-lens-account,
      // bypassing both App.jsx (where the create-account button is hidden
      // for wallets that already have an account) and Onboarding.jsx. So
      // the check HERE is mandatory: without it, the earlier safeguards in
      // LensAuthContext and App.jsx would be worthless, since the
      // onboardingUser session (and therefore creating a new account)
      // could be opened directly from here. fetchExistingAccounts goes
      // directly to the Lens API — we don't rely on local state, since
      // this page could have been opened without going through App.jsx.
      // Runs regardless of whether we'll reuse an existing session below
      // or log in fresh — it's cheap (a read-only API call) and closes
      // the same edge case either way.
      try {
        const existing = await fetchExistingAccounts(address);
        if (cancelled) return;
        if (existing.length > 0) {
          setWalletAlreadyHasAccount(true);
          setSessionLoading(false);
          return;
        }
      } catch (err) {
        // If the check itself failed with a network error — better not to
        // block a legitimate new user, but log it.
        console.warn("Existing accounts check failed:", err.message);
      }

      // FIXED: this used to be the actual source of an extra MetaMask
      // signature request. Previously this effect ALWAYS called
      // lensClient.login({ onboardingUser: ... }) below, even though
      // App.jsx's "Create Lens account" button had already called the
      // exact same login (via loginAsOnboardingUser in
      // LensAuthContext) and stored the result in the shared context
      // via setExternalSessionClient — this component just never
      // looked at it. So the user signed once on the login screen, and
      // then signed AGAIN here for literally the same onboarding
      // session, for no reason. Now: if the context already has a
      // session, we just adopt it directly and skip the login/
      // signature entirely.
      if (contextSessionClient) {
        setSessionClient(contextSessionClient);
        setSessionLoading(false);
        return;
      }

      localStorage.removeItem("lens_account_address");
      try {
        const result = await lensClient.login({
          onboardingUser: {
            app: import.meta.env.VITE_LENS_APP_ADDRESS,
            wallet: address,
          },
          signMessage: signMessageWith(walletClient),
        });

        if (cancelled) return;

        if (result.isErr()) {
          setError(result.error.message);
          return;
        }
        setSessionClient(result.value);
        // FIXED: previously this onboarding session stayed ONLY in this
        // component's local state. If the user left the page without
        // finishing account creation, LensAuthContext knew nothing about
        // this session — and its logout() couldn't revoke it. The token
        // would remain valid in the Lens SDK's storage and "come back to
        // life" on the next lensClient.resumeSession(), causing endless
        // loading on other pages. We register the session in the context
        // right away — now authLogout() from Onboarding.jsx (and
        // anywhere else) actually closes it.
        setExternalSessionClient(result.value);
      } catch (err) {
        if (!cancelled) {
          console.error("Onboarding session error:", err);
          setError(err.message);
        }
      } finally {
        if (!cancelled) setSessionLoading(false);
      }
    };

    ensureOnboardingSession();
    return () => {
      cancelled = true;
    };
  }, [walletClient, address, sessionClient, contextSessionClient]);

  const normalizeUsername = (raw) =>
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_");

  // === Checking username uniqueness via Lens ===
  const checkUsernameAvailability = useCallback(
    async (rawName) => {
      const localName = normalizeUsername(rawName.trim());

      if (!localName) {
        setUsernameStatus("idle");
        setUsernameMessage("");
        return;
      }

      if (localName.length < 3) {
        setUsernameStatus("invalid");
        setUsernameMessage(t("username_too_short"));
        return;
      }

      if (!sessionClient) {
        // The session isn't ready yet — we'll wait, the actual check
        // will happen again once sessionClient appears
        setUsernameStatus("idle");
        setUsernameMessage("");
        return;
      }

      setUsernameStatus("checking");
      setUsernameMessage("");

      try {
        const result = await canCreateUsername(sessionClient, {
          localName,
        });

        if (result.isErr()) {
          setUsernameStatus("error");
          setUsernameMessage(t("name_check_error"));
          return;
        }

        switch (result.value.__typename) {
          case "NamespaceOperationValidationPassed":
            setUsernameStatus("available");
            setUsernameMessage("");
            break;
          case "UsernameTaken":
            setUsernameStatus("taken");
            setUsernameMessage(t("name_already_taken"));
            break;
          case "NamespaceOperationValidationFailed":
            setUsernameStatus("invalid");
            setUsernameMessage(result.value.reason || t("name_not_allowed"));
            break;
          default:
            setUsernameStatus("error");
            setUsernameMessage(t("name_check_error"));
        }
      } catch (err) {
        console.error("canCreateUsername error:", err);
        setUsernameStatus("error");
        setUsernameMessage(t("name_check_error"));
      }
    },
    [sessionClient, t],
  );

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));

    if (name === "unique_name") {
      setUsernameStatus("idle");
      setUsernameMessage("");
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        checkUsernameAvailability(value);
      }, USERNAME_CHECK_DEBOUNCE_MS);
    }
  };

  // === Handling country selection (like in ProfileEditModal) ===
  const handleSelectEarth = () => {
    setFormData((prev) => ({
      ...prev,
      country: "EARTH",
      h3Index: null,
    }));
    setSuccess(t("earth_selected"));
    setTimeout(() => setSuccess(""), 3000);
  };

  const handleDetectLocation = async () => {
    try {
      const location = await detectLocation();
      setFormData((prev) => ({
        ...prev,
        country: location.countryCode,
        h3Index: location.h3Index,
      }));
      setSuccess(t("location_detected"));
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(err.message);
    }
  };

  // If the session appears later than the user typed their name — check again
  useEffect(() => {
    if (
      sessionClient &&
      formData.unique_name.trim() &&
      usernameStatus === "idle"
    ) {
      checkUsernameAvailability(formData.unique_name);
    }
  }, [sessionClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const validateForm = () => {
    const errors = {};

    if (!formData.unique_name.trim()) {
      errors.unique_name = t("please_enter_unique_name");
    } else if (usernameStatus === "taken" || usernameStatus === "invalid") {
      errors.unique_name = usernameMessage || t("name_already_taken");
    } else if (usernameStatus !== "available") {
      errors.unique_name = t("please_wait_name_check");
    }

    if (!formData.country) {
      errors.country = t("please_select_country");
    }

    if (!termsAccepted) {
      errors.terms = t("please_accept_terms");
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleCreateAccount = async () => {
    if (!walletClient) {
      setError(t("wallet_not_connected"));
      return;
    }

    if (!validateForm()) return;

    // ADDED: a defensive check here too, not just via disabled on the
    // button (canSubmit) - in case handleCreateAccount is ever called
    // some other way, bypassing the button.
    if (!captchaVerified) {
      setError(t("please_complete_captcha") || "Please complete the CAPTCHA check");
      return;
    }

    if (!sessionClient) {
      setError(t("session_not_ready"));
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const localName = normalizeUsername(formData.unique_name.trim());

      // Last line of defense against race conditions: check once more right before submitting
      const finalCheck = await canCreateUsername(sessionClient, {
        localName,
      });
      if (
        finalCheck.isErr() ||
        finalCheck.value.__typename !== "NamespaceOperationValidationPassed"
      ) {
        setUsernameStatus("taken");
        setUsernameMessage(t("name_already_taken"));
        setError(t("name_already_taken"));
        setSubmitting(false);
        return;
      }

      // === Building the account metadata with custom attributes ===
      const attributes = [
        {
          key: "isAdult",
          value: "true",
          type: MetadataAttributeType.BOOLEAN,
        },
        {
          key: "hasAcceptedTerms",
          value: "true",
          type: MetadataAttributeType.BOOLEAN,
        },
        {
          key: "country",
          value: formData.country || "EARTH",
          type: MetadataAttributeType.STRING,
        },
        // h3Index — added ONLY if there's a value
        ...(formData.h3Index
          ? [
              {
                key: "h3Index",
                value: formData.h3Index,
                type: MetadataAttributeType.STRING,
              },
            ]
          : []),
        {
          key: "termsAcceptedAt",
          value:
            localStorage.getItem("terms_accepted_at") ||
            new Date().toISOString(),
          type: MetadataAttributeType.STRING,
        },
      ];

      const metadata = account({
        name: formData.unique_name.trim(),
        bio: "Dossier member — from HRP DAO",
        attributes,
      });

      const { uri: metadataUri } = await storageClient.uploadAsJson(metadata);

      // === Full transaction lifecycle ===
      // 1. createAccountWithUsername — builds the operation
      // 2. handleOperationWith(walletClient) — signs and sends the transaction
      // 3. sessionClient.waitForTransaction — waits for the transaction to be indexed
      // 4. fetchAccount — fetches the now-indexed account by txHash
      // 5. switchAccount — switches the session from onboardingUser to Account Owner
      // Without this chain, subsequent pages (fetchAccountsAvailable) still
      // don't see the new account and consider onboarding not completed.
      setSubmitStage("signing");
      const result = await createAccountWithUsername(sessionClient, {
        username: { localName },
        metadataUri,
      })
        .andThen(handleOperationWith(walletClient))
        .andThen((txHash) => {
          setSubmitStage("confirming");
          return sessionClient.waitForTransaction(txHash);
        })
        .andThen((txHash) => fetchAccount(sessionClient, { txHash }));

      if (result.isErr()) {
        throw new Error(result.error.message);
      }

      const newAccount = result.value;

      if (!newAccount) {
        throw new Error(t("account_creation_failed"));
      }

      setSubmitStage("finishing");

      // Switch the session to the role of owner of the newly created account
      const switchResult = await sessionClient.switchAccount({
        account: newAccount.address,
      });

      if (switchResult.isErr()) {
        throw new Error(switchResult.error.message);
      }

      setExternalSessionClient(switchResult.value);
      // The account was successfully created — this is no longer an
      // onboarding session, but a full account-owner session. We flag
      // this so the cleanup effect on component unmount does NOT revoke
      // this (now legitimate) session.
      accountCreatedRef.current = true;
      localStorage.setItem("lens_account_address", newAccount.address);
      localStorage.setItem("lens_wallet_address", address);

      navigate("/country");
    } catch (err) {
      console.error("Create account error:", err);
      setError(err.message);
    } finally {
      setSubmitting(false);
      setSubmitStage("");
    }
  };

  const inputCls = `w-full h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03]
    border border-slate-300 dark:border-white/[0.1] rounded-lg text-[16px]
    text-slate-900 dark:text-white/65 placeholder-slate-400 dark:placeholder-white/[0.18] font-['Inter']
    outline-none transition-all appearance-none
    focus:border-blue-500/35 focus:ring-1 focus:ring-blue-500/15`;

  const labelCls = `block text-[11px] text-slate-500 dark:text-white/40
    uppercase tracking-[0.1em] mb-1.5`;

  const errorCls = `text-[11px] text-red-400/70 mt-1`;

  const usernameHintCls = {
    checking: "text-slate-600 dark:text-white/40",
    available: "text-green-400/70",
    taken: "text-red-400/70",
    invalid: "text-red-400/70",
    error: "text-red-400/70",
    idle: "",
  }[usernameStatus];

  const usernameHintText = {
    checking: t("checking_name"),
    available: t("name_available"),
    taken: usernameMessage,
    invalid: usernameMessage,
    error: usernameMessage,
    idle: "",
  }[usernameStatus];

  const canSubmit =
    usernameStatus === "available" &&
    !submitting &&
    !sessionLoading &&
    !!formData.country &&
    termsAccepted &&
    captchaVerified;

  // === The wallet already has a Lens account — don't show the form at all ===
  if (walletAlreadyHasAccount) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#00091c] p-4">
        <div className="max-w-md w-full bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.08] rounded-2xl p-6 space-y-4 text-center">
          <h1 className="font-cinzel text-[16px] font-medium text-slate-900 dark:text-white/65 tracking-[0.04em]">
            {t("wallet_already_has_account_title") ||
              "This wallet already has a Lens account"}
          </h1>
          <p className="text-[14px] text-slate-700 dark:text-white/45 leading-relaxed">
            {t("wallet_already_has_account_desc") ||
              "A single wallet can have only one Lens account. Log in with it."}
          </p>
          <button
            onClick={() => navigate("/")}
            className="w-full py-2.5 rounded-xl text-[14px] font-medium
              bg-[#2B000A] border border-[#b41e3c]/30 text-[#e8a0b0]/80
              hover:bg-[#3d0012] transition-colors"
          >
            {t("go_to_login") || "Go to home"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#00091c] p-4">
      <div className="max-w-md w-full bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.08] rounded-2xl p-6 space-y-5">
        <div className="text-center pb-4 border-b border-slate-300 dark:border-white/[0.06]">
          <h1 className="font-cinzel text-[16px] font-medium text-slate-900 dark:text-white/65 tracking-[0.04em] mb-2">
            {t("welcome_to_hrp_dao")}
          </h1>
          <p className="text-[11px] text-slate-600 dark:text-white/40 leading-relaxed">
            {t("create_lens_account_intro")}
          </p>
        </div>

        {error && (
          <div className="p-3 bg-red-500/[0.06] border border-red-500/20 rounded-xl">
            <p className="text-[11px] text-red-400/80">{error}</p>
          </div>
        )}

        {success && (
          <div className="p-3 bg-emerald-500/[0.06] border border-emerald-500/20 rounded-xl">
            <p className="text-[11px] text-emerald-400/80">{success}</p>
          </div>
        )}

        {sessionLoading && (
          <div className="flex items-center justify-center gap-2 py-2">
            <span className="w-3.5 h-3.5 border-2 border-slate-300 dark:border-white/30 border-t-transparent rounded-full animate-spin" />
            <span className="text-[11px] text-slate-600 dark:text-white/40">
              {t("preparing_session")}
            </span>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className={labelCls}>{t("unique_name")} *</label>
            <input
              type="text"
              name="unique_name"
              value={formData.unique_name}
              onChange={handleChange}
              placeholder={t("enter_unique_name")}
              required
              className={`${inputCls} ${
                formErrors.unique_name ||
                usernameStatus === "taken" ||
                usernameStatus === "invalid"
                  ? "border-red-500/40"
                  : usernameStatus === "available"
                    ? "border-green-500/30"
                    : ""
              }`}
            />
            {usernameHintText && (
              <p className={`text-[11px] mt-1 ${usernameHintCls}`}>
                {usernameHintText}
              </p>
            )}
            {formErrors.unique_name && !usernameHintText && (
              <p className={errorCls}>{formErrors.unique_name}</p>
            )}
          </div>

          <div>
            <label className={labelCls}>{t("country")} *</label>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={handleSelectEarth}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[16px]
                  border transition-all w-full
                  ${
                    formData.country === "EARTH"
                      ? "border-blue-500/40 bg-blue-900/15 text-blue-400/80"
                      : "border-slate-300 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.02] text-slate-700 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.14]"
                  }`}
              >
                <Globe className="w-3.5 h-3.5" />
                {t("earth") || "Planet Earth"}
                {formData.country === "EARTH" && (
                  <span className="ml-auto text-[11px] text-blue-400/60">
                    ✓
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={handleDetectLocation}
                disabled={countryLoading}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[16px]
                  border transition-all w-full disabled:opacity-50
                  ${
                    formData.country && formData.country !== "EARTH"
                      ? "border-emerald-500/35 bg-emerald-900/12 text-emerald-400/75"
                      : "border-slate-300 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.02] text-slate-700 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.14]"
                  }`}
              >
                {countryLoading ? (
                  <Loader className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <MapPin className="w-3.5 h-3.5" />
                )}
                {countryLoading ? t("detecting") : t("detect_location")}
                {formData.country &&
                  formData.country !== "EARTH" &&
                  !countryLoading && (
                    <span className="ml-auto text-[11px] font-medium">
                      {getTranslatedCountryName(formData.country)} ✓
                    </span>
                  )}
              </button>
            </div>

            <p className="text-[11px] text-slate-600 dark:text-white/40 mt-1">
              {t("country_detection_hint")}
            </p>

            {formData.h3Index && (
              <div
                className="flex items-center gap-2 px-3 py-2 mt-1.5 rounded-lg
                  border border-indigo-500/25 bg-indigo-900/10 text-indigo-400/65"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="w-3.5 h-3.5 fill-current flex-shrink-0"
                >
                  <polygon points="12,2 21,7 21,17 12,22 3,17 3,7" />
                </svg>
                <span className="font-mono text-[11px] truncate">
                  {formData.h3Index}
                </span>
                <span className="ml-auto text-[11px] opacity-50">
                  {t("resolution_level_3")}
                </span>
              </div>
            )}
          </div>

          {/* Confirming age 18+, privacy policy, and terms.
              Without this checkbox, isAdult/hasAcceptedTerms cannot be
              true in the on-chain metadata — so we block the button. */}
          <label className="flex items-start gap-3 cursor-pointer group p-3 rounded-xl border border-slate-300 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.02] hover:border-slate-400 dark:hover:border-white/[0.14] transition-all">
            <div className="relative mt-0.5 flex-shrink-0">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => handleTermsAccept(e.target.checked)}
                className="sr-only"
              />
              <div
                className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                  termsAccepted
                    ? "bg-[#2B000A] border-[#2B000A]"
                    : "bg-transparent border-slate-400 dark:border-white/30 group-hover:border-slate-500 dark:group-hover:border-white/50"
                }`}
              >
                {termsAccepted && (
                  <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 10 10">
                    <polyline
                      points="1.5,5 4,7.5 8.5,2"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      fill="none"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              </div>
            </div>
            <div className="text-[11px] text-slate-700 dark:text-gray-400 leading-relaxed space-y-1">
              <p className="text-slate-700 dark:text-white/45 font-medium mb-1.5">
                {t("i_confirm_that")}
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-slate-600 dark:text-white/40 mt-0.5">
                  ·
                </span>
                {t("i_am_18_years_old_prefix")}{" "}
                <span className="text-slate-700 dark:text-white/70 font-medium mx-1">
                  {t("18_years_old")}
                </span>
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-slate-600 dark:text-white/40 mt-0.5">
                  ·
                </span>
                <span>
                  {t("i_have_read")}{" "}
                  <a
                    href="/privacy-page"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400/80 hover:text-blue-400 hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t("privacy_policy")}
                  </a>
                </span>
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-slate-600 dark:text-white/40 mt-0.5">
                  ·
                </span>
                <span>
                  {t("i_agree_to")}{" "}
                  <a
                    href="/terms-of-service"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400/80 hover:text-blue-400 hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t("terms_of_service")}
                  </a>
                </span>
              </p>
            </div>
          </label>
          {formErrors.terms && <p className={errorCls}>{formErrors.terms}</p>}

          {/* ADDED: a real CAPTCHA before submitting - CaptchaGate loads
              the Turnstile widget itself and sends the token to
              /verify-captcha for server-side verification on its own.
              While captchaVerified isn't true - canSubmit won't let the
              button through. */}
          {!captchaVerified && (
            <CaptchaGate
              onVerified={() => setCaptchaVerified(true)}
              onError={(reason) => {
                console.warn("⚠️ CAPTCHA not passed:", reason);
              }}
            />
          )}

          <button
            onClick={handleCreateAccount}
            disabled={!canSubmit}
            className="w-full py-2.5 rounded-xl text-[14px] font-medium
              bg-[#2B000A] border border-[#b41e3c]/30 text-[#e8a0b0]/80
              hover:bg-[#3d0012] transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed
              flex items-center justify-center gap-2"
          >
            {submitting && (
              <span className="w-3.5 h-3.5 border-2 border-[#e8a0b0]/50 border-t-transparent rounded-full animate-spin" />
            )}
            {submitting
              ? {
                  signing: t("submit_stage_signing"),
                  confirming: t("submit_stage_confirming"),
                  finishing: t("submit_stage_finishing"),
                }[submitStage] || t("processing")
              : t("create_lens_account_button")}
          </button>
        </div>
      </div>
    </div>
  );
}
