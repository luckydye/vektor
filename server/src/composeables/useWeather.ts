import type { TranslationKey } from "#utils/lang.ts";
import { useQuery } from "./query.ts";

export interface Weather {
  condition: TranslationKey;
  temperature: number;
  high: number;
  low: number;
  precipitationChance: number;
}

interface OpenMeteoForecast {
  current: { temperature_2m: number; weather_code: number };
  daily: {
    temperature_2m_max: [number];
    temperature_2m_min: [number];
    precipitation_probability_max: [number];
  };
}

/** Maps a WMO weather code from Open-Meteo to a condition label. */
function describeWeather(code: number): TranslationKey {
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "Rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "Snow";
  if (code >= 95 && code <= 99) return "Thunderstorm";
  throw new Error(`Unknown WMO weather code: ${code}`);
}

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, { maximumAge: 60 * 60 * 1000 }),
  );
}

/** Today's weather at the browser's location; stays empty when location access is denied. */
export function useWeather() {
  const { data } = useQuery<Weather>({
    queryKey: ["weather"],
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { coords } = await currentPosition();
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", coords.latitude.toFixed(2));
      url.searchParams.set("longitude", coords.longitude.toFixed(2));
      url.searchParams.set("current", "temperature_2m,weather_code");
      url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max");
      url.searchParams.set("forecast_days", "1");
      url.searchParams.set("timezone", "auto");
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Open-Meteo responded ${response.status}`);
      const { current, daily } = (await response.json()) as OpenMeteoForecast;
      return {
        condition: describeWeather(current.weather_code),
        temperature: Math.round(current.temperature_2m),
        high: Math.round(daily.temperature_2m_max[0]),
        low: Math.round(daily.temperature_2m_min[0]),
        precipitationChance: daily.precipitation_probability_max[0],
      };
    },
  });
  return data;
}
