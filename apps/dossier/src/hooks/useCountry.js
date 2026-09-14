// hooks/useCountry.js
import { useState, useCallback } from "react";
import countries from "../utils/countries";
import { latLngToCell } from "h3-js"; // вже є в проєкті через ViolationsMap

export const useCountry = (userLanguage = "en") => {
  const [country, setCountry] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [autoDetectedCountry, setAutoDetectedCountry] = useState(null);
  const [detectionStatus, setDetectionStatus] = useState("idle");

  // Language code mapping to keys in the name object
  const langMap = {
    en: "en",
    uk: "uk",
    es: "es",
    fr: "fr",
    de: "de",
    zh: "zh",
    hi: "hi",
    ar: "ar",
    pt: "pt",
    ru: "ru",
    ja: "ja",
  };

  // Get translated country name
  const getTranslatedCountryName = useCallback(
    (countryCode) => {
      if (!countryCode) return "";

      const foundCountry = countries.find((c) => c.code === countryCode);
      if (!foundCountry) return countryCode;

      const langKey = langMap[userLanguage] || "en";
      return foundCountry.name[langKey] || foundCountry.name.en;
    },
    [userLanguage],
  );

  // Get country by code
  const getCountryByCode = useCallback((countryCode) => {
    return countries.find((c) => c.code === countryCode);
  }, []);

  // Get all countries with translations
  const getAllCountries = useCallback(() => {
    return countries.map((country) => ({
      code: country.code,
      name: getTranslatedCountryName(country.code),
    }));
  }, [getTranslatedCountryName]);

  // Main automatic location detection function
  const detectLocation = async () => {
    setLoading(true);
    setDetectionStatus("detecting");
    setError(null);

    try {
      let locationData;

      // First try browser geolocation
      try {
        locationData = await getBrowserLocation();
      } catch (browserError) {
        console.warn("Browser geolocation failed:", browserError);

        // If that fails, try IP-based geolocation
        try {
          locationData = await getIPLocation();
        } catch (ipError) {
          console.warn("IP geolocation failed:", ipError);
          throw new Error("Failed to determine your location");
        }
      }

      if (locationData && locationData.countryCode) {
        // Обчислення H3 індексу на основі координат
        let h3Index = null;
        if (
          locationData.coordinates?.latitude &&
          locationData.coordinates?.longitude
        ) {
          const { latitude, longitude } = locationData.coordinates;
          h3Index = latLngToCell(latitude, longitude, 3); // GRID_RESOLUTION = 3
        }

        const detected = {
          code: locationData.countryCode,
          name: getTranslatedCountryName(locationData.countryCode),
          detectedAt: new Date().toISOString(),
          method: locationData.method,
          coordinates: locationData.coordinates,
          h3Index,
        };

        setAutoDetectedCountry(detected);
        setDetectionStatus("success");
        return { ...locationData, ...detected, h3Index };
      } else {
        throw new Error("Country not found");
      }
    } catch (error) {
      console.error("Location detection error:", error);
      setError(error.message);
      setDetectionStatus("error");

      // Fallback to Earth
      const earthCountry = getCountryByCode("EARTH");
      const fallback = {
        code: "EARTH",
        name: getTranslatedCountryName("EARTH"),
        detectedAt: new Date().toISOString(),
        method: "fallback",
      };

      setAutoDetectedCountry(fallback);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  // Browser geolocation
  const getBrowserLocation = () => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation is not supported by your browser"));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        async (position) => {
          try {
            const { latitude, longitude } = position.coords;

            const response = await fetch(
              `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&accept-language=${userLanguage}`,
            );

            if (!response.ok) throw new Error("Geocoding error");

            const data = await response.json();
            const countryCode = data.address?.country_code?.toUpperCase();

            if (countryCode) {
              resolve({
                countryCode,
                countryName: data.address.country,
                coordinates: { latitude, longitude },
                address: data.address,
                method: "browser_geolocation",
                accuracy: position.coords.accuracy,
              });
            } else {
              reject(new Error("Country not found in geodata"));
            }
          } catch (error) {
            reject(error);
          }
        },
        (error) => {
          let errorMessage = "Geolocation error";
          switch (error.code) {
            case error.PERMISSION_DENIED:
              errorMessage = "Geolocation permission denied";
              break;
            case error.POSITION_UNAVAILABLE:
              errorMessage = "Location information unavailable";
              break;
            case error.TIMEOUT:
              errorMessage = "Geolocation timeout";
              break;
          }
          reject(new Error(errorMessage));
        },
        {
          timeout: 10000,
          maximumAge: 600000,
          enableHighAccuracy: true,
        },
      );
    });
  };

  // IP-based geolocation
  const getIPLocation = async () => {
    try {
      const services = [
        "https://ipapi.co/json/",
        "https://ipinfo.io/json",
        "https://geolocation-db.com/json/",
      ];

      for (const serviceUrl of services) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);

          const response = await fetch(serviceUrl, {
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) continue;

          const data = await response.json();

          // Handle ipinfo.io special case (coordinates in 'loc' field)
          if (serviceUrl.includes("ipinfo.io") && data.loc) {
            const [lat, lon] = data.loc.split(",").map(Number);
            const countryCode = data.country_code || data.countryCode;

            if (countryCode) {
              return {
                countryCode: countryCode.toUpperCase(),
                countryName: data.country_name || data.country,
                ip: data.ip,
                city: data.city,
                region: data.region,
                timezone: data.timezone,
                method: "ip_geolocation",
                service: serviceUrl,
                coordinates:
                  lat && lon ? { latitude: lat, longitude: lon } : null,
              };
            }
          }

          // Standard handling for other services
          const countryCode = data.country_code || data.countryCode;

          // Extract coordinates from different possible field names
          const latitude = data.latitude ?? data.lat ?? null;
          const longitude = data.longitude ?? data.lon ?? data.lng ?? null;

          if (countryCode) {
            return {
              countryCode: countryCode.toUpperCase(),
              countryName: data.country_name || data.country,
              ip: data.ip,
              city: data.city,
              region: data.region,
              timezone: data.timezone,
              method: "ip_geolocation",
              service: serviceUrl,
              coordinates:
                latitude && longitude ? { latitude, longitude } : null,
            };
          }
        } catch (serviceError) {
          console.warn(`Service ${serviceUrl} failed:`, serviceError);
          continue;
        }
      }

      throw new Error("All geolocation services failed");
    } catch (error) {
      throw new Error(`IP geolocation failed: ${error.message}`);
    }
  };

  // Reset detected location
  const resetDetection = () => {
    setAutoDetectedCountry(null);
    setDetectionStatus("idle");
    setError(null);
  };

  return {
    // Data
    country,
    userLocation,
    autoDetectedCountry,
    loading,
    error,
    detectionStatus,

    // Functions
    getTranslatedCountryName,
    getCountryByCode,
    getAllCountries,
    detectLocation,
    resetDetection,
  };
};
