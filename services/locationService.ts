import { GoogleGenAI, Type } from "@google/genai";
import { GEONAMES_USER, ORS_KEY, OPENTRIPMAP_KEY, RATES, SUGGESTED_CITIES, IDSS_COORDS } from '../constants';
import { TripFormState, PlannerResult, TripPlan, GeoLocation, Poi, CostBreakdown, ItineraryDay, SourceLink } from '../types';

/* ===========================
   Utilities
   =========================== */

// Helper to get API Key securely with rotation
const getGeminiApiKey = (): string | undefined => {
  // 1. Try to get the list of keys from environment variables
  // VITE_GEMINI_API_KEYS should be a comma-separated string of keys in Vercel
  const keysString = process.env.VITE_GEMINI_API_KEYS || process.env.API_KEY;

  if (!keysString) return undefined;

  // Split by comma and clean up whitespace
  const keys = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);

  if (keys.length === 0) return undefined;

  // 2. Randomly select one key from the available list
  // This simple rotation strategy distributes load effectively across multiple free-tier accounts.
  const randomIndex = Math.floor(Math.random() * keys.length);
  return keys[randomIndex];
};

export function normalizeDate(input: string): string | null {
  if (!input) return null;
  let s = String(input).trim();
  
  // Handle ISO YYYY-MM-DD from date picker
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-');
      return `${d}.${m}.${y}`;
  }

  s = s.replace(/[\/\-\s]+/g, '.');
  s = s.replace(/^\.+|\.+$/g, '');
  const parts = s.split('.');
  if (parts.length !== 3) return null;
  let [d, m, y] = parts.map(p => p.replace(/^0+/, '') || '0');
  
  if (!/^\d{1,4}$/.test(d) || !/^\d{1,4}$/.test(m) || !/^\d{1,4}$/.test(y)) return null;
  
  d = d.padStart(2, '0');
  m = m.padStart(2, '0');
  
  if (y.length === 2) {
    const yi = parseInt(y, 10);
    y = yi <= 49 ? ('20' + y) : ('19' + y);
  } else if (y.length === 1) {
    y = '200' + y;
  } else if (y.length === 3) {
    return null;
  }
  
  if (y.length !== 4) return null;
  const di = parseInt(d, 10), mi = parseInt(m, 10), yi = parseInt(y, 10);
  if (mi < 1 || mi > 12) return null;
  const mdays = [31, ((yi % 4 === 0 && yi % 100 !== 0) || yi % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (di < 1 || di > mdays[mi - 1]) return null;
  
  return `${d}.${m}.${y}`;
}

export function parseDateNormalized(s: string | null): Date | null {
  const n = s ? normalizeDate(s) : null;
  if (!n) return null;
  const p = n.split('.');
  return new Date(parseInt(p[2], 10), parseInt(p[1], 10) - 1, parseInt(p[0], 10));
}

export function daysInclusive(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

function safe(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const toRad = (d: number) => d * Math.PI / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1), Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function cleanJsonString(str: string): string {
  if (!str) return '{}';
  // Remove markdown code blocks if present (```json ... ```)
  return str.replace(/```json/g, '').replace(/```/g, '').trim();
}

/* ===========================
   API Calls
   =========================== */

export async function geocodeGeoNames(query: string): Promise<GeoLocation | null> {
  if (!GEONAMES_USER) return null;
  const url = `https://secure.geonames.org/searchJSON?q=${encodeURIComponent(query)}&maxRows=1&username=${encodeURIComponent(GEONAMES_USER)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('GeoNames error ' + res.status);
    const j = await res.json();
    if (j.geonames && j.geonames.length) {
      const g = j.geonames[0];
      return {
        lat: parseFloat(g.lat),
        lng: parseFloat(g.lng),
        name: g.name + (g.adminName1 ? (', ' + g.adminName1) : ''),
        source: 'geonames',
        url: `https://www.geonames.org/${g.geonameId}`
      };
    }
  } catch (e) {
    console.warn('geonames fail', e);
  }
  return null;
}

export async function geocodeORS(query: string): Promise<GeoLocation | null> {
  if (!ORS_KEY) return null;
  const url = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_KEY}&text=${encodeURIComponent(query)}&size=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('ORS geocode ' + res.status);
    const j = await res.json();
    if (j.features && j.features.length) {
      const f = j.features[0];
      const [lon, lat] = f.geometry.coordinates;
      return {
        lat,
        lng: lon,
        name: f.properties.label || f.text,
        source: 'ors',
        url: f.properties?.website || null
      };
    }
  } catch (e) {
    console.warn('ors geocode fail', e);
  }
  return null;
}

async function wikidataPOIs(lat: number, lng: number, radius_km = 15, focus = 'museum'): Promise<Poi[]> {
  let instanceQ = 'Q3350036'; // museum
  const lower = (focus || '').toLowerCase();
  if (lower.includes('science') || lower.includes('nauka') || lower.includes('education')) instanceQ = 'Q201184';
  if (lower.includes('park') || lower.includes('zabava')) instanceQ = 'Q7889';
  
  const sparql = `
    SELECT ?item ?itemLabel ?coord ?site WHERE {
      SERVICE wikibase:box { ?item wdt:P625 ?coord . bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "${radius_km}" . }
      ?item wdt:P31/wdt:P279* wd:${instanceQ}.
      OPTIONAL { ?item wdt:P856 ?site. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "[AUTO_LANGUAGE],en,bs,de,it" }
    } LIMIT 50
  `;
  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql);
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/sparql-results+json' } });
    if (!r.ok) throw new Error('Wikidata ' + r.status);
    const j = await r.json();
    return j.results.bindings.map((b: any) => {
      const coord = b.coord.value.replace('Point(', '').replace(')', '').split(' ');
      return {
        label: b.itemLabel.value,
        lat: parseFloat(coord[1]),
        lng: parseFloat(coord[0]),
        url: b.site ? b.site.value : null,
        source: 'wikidata'
      };
    });
  } catch (e) {
    console.warn('wikidata fail', e);
    return [];
  }
}

async function fetchOpenTripMapPOIs(lat: number, lng: number, radius_m = 10000): Promise<Poi[]> {
  if (!OPENTRIPMAP_KEY) return [];
  
  const kinds = 'interesting_places'; 
  const rate = '2';
  
  const url = `https://api.opentripmap.com/0.1/en/places/radius?radius=${radius_m}&lon=${lng}&lat=${lat}&kinds=${kinds}&rate=${rate}&format=json&limit=15&apikey=${OPENTRIPMAP_KEY}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('OTM error ' + res.status);
    const data = await res.json();
    
    return data.map((item: any) => ({
      label: item.name,
      lat: item.point.lat,
      lng: item.point.lon,
      url: `https://opentripmap.com/en/card/${item.xid}`, 
      source: 'opentripmap'
    })).filter((p: any) => p.label && p.label.trim().length > 0);
  } catch (e) {
    console.warn('OpenTripMap fail', e);
    return [];
  }
}

async function orsRouteDistance(coordinates: [number, number][]) {
  if (!ORS_KEY) return null;
  try {
    const res = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': ORS_KEY },
      body: JSON.stringify({ coordinates })
    });
    if (!res.ok) throw new Error('ORS directions ' + res.status);
    const j = await res.json();
    const summary = j.features?.[0]?.properties?.summary || null;
    const coords = j.features?.[0]?.geometry?.coordinates || [];
    return {
      distance_m: summary ? summary.distance : null,
      duration_s: summary ? summary.duration : null,
      polyline: coords.map((c: any) => [c[1], c[0]]) as [number, number][]
    };
  } catch (e) {
    console.warn('ors route fail', e);
    return null;
  }
}

async function orsPOIsAround(lon: number, lat: number, radius_m = 7000) {
  if (!ORS_KEY) return [];
  const deg = radius_m / 111320;
  const bbox = [lon - deg, lat - deg, lon + deg, lat + deg];
  const body = {
    request: "pois",
    geometry: { bbox: bbox, geojson: { type: "Polygon", coordinates: [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]] } },
    filters: { "osm_tags": { 'tourism': 'museum' } },
    size: 50
  };
  try {
    const res = await fetch('https://api.openrouteservice.org/pois', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': ORS_KEY },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('ORS POI error ' + res.status);
    const j = await res.json();
    return (j.features || []).map((f: any) => {
      const c = f.geometry.coordinates;
      return {
        label: f.properties.name || f.properties.tags?.name || f.properties.type || 'POI',
        lat: c[1],
        lng: c[0],
        url: f.properties.website || f.properties.url || null,
        source: 'ors'
      };
    });
  } catch (e) {
    console.warn('ORS POI fail', e);
    return [];
  }
}

/* ===========================
   Gemini AI Integration
   =========================== */

async function getGeminiSuggestions(prompt: string, lat: number, lng: number): Promise<Poi[]> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return [];
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        tools: [{ googleMaps: {} }],
        toolConfig: {
          retrievalConfig: {
            latLng: { latitude: lat, longitude: lng }
          }
        }
      }
    });

    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (!chunks) return [];

    const results: Poi[] = [];
    const seen = new Set<string>();

    for (const chunk of chunks) {
      if (chunk.maps?.title) {
        const title = chunk.maps.title;
        if (!seen.has(title)) {
          seen.add(title);
          results.push({
            label: title,
            lat: 0, 
            lng: 0,
            url: chunk.maps.uri || null,
            source: 'google-maps'
          });
        }
      }
    }
    return results;
  } catch (e) {
    console.warn("Gemini Maps Grounding error:", e);
    return [];
  }
}

interface GenItineraryResult {
  itinerary: ItineraryDay[];
  poi_descriptions: { name: string, description: string }[];
}

async function generateGeminiItinerary(
  destinations: string[],
  days: number,
  grade: string,
  focus: string,
  tier: string,
  origin: string,
  travelTimeHours: number, 
  poiList: { label: string, url: string | null }[],
  notes?: string
): Promise<GenItineraryResult> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return { itinerary: [], poi_descriptions: [] };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    
    const uniquePois = poiList.filter((poi, index, self) => 
      index === self.findIndex((t) => (t.label === poi.label))
    ).slice(0, 15);

    const poiContext = uniquePois.map(p => `- ${p.label}${p.url ? ` (URL: ${p.url})` : ''}`).join('\n');
    
    const tripPath = [origin, ...destinations].join(' -> ');

    const prompt = `
      You are a world-class educational travel specialist. Create a deeply detailed, logistical, and educational day-by-day itinerary for a ${days}-day school trip.
      
      ROUTE: ${tripPath}
      (The trip must visit these locations in order, starting from ${origin} and ENDING in ${origin})

      PARAMETERS:
      - Grade Level: ${grade}
      - Primary Focus: ${focus}
      - Budget Tier: ${tier} (STRICTLY ADHERE TO THIS FOR DINING CHOICES)
      - One-way Return Travel Duration from last stop: Approx ${Math.ceil(travelTimeHours)} hours.
      - SPECIAL NOTES/REQUIREMENTS: ${notes || "None"} (Ensure these are reflected in the itinerary!)
      
      CONTEXTUAL POIs (Use these if relevant to the stops):
      ${poiContext}

      STRICT OUTPUT FORMAT:
      For EVERY day, provide a chronological list of activities.
      EVERY activity block MUST start with a specific time range in this exact format: "HH:MM AM - HH:MM PM".

      CONTENT REQUIREMENTS:
      1.  **Day 1**: "08:00 AM - Departure from ${origin}..." followed by travel, arrival, and evening activity.
      2.  **Middle Days**: Full sightseeing.
          - **Morning**: "09:00 AM - 12:00 PM - Visit [Specific Site]..."
          - **Lunch**: "12:00 PM - 01:30 PM - Lunch at [Specific Restaurant Name]..." (MUST be a real, specific place suitable for students and the budget tier: ${tier}).
          - **Afternoon**: "02:00 PM - 05:00 PM - Visit [Specific Site]..."
          - **Evening**: "06:30 PM - 08:30 PM - Dinner at [Specific Restaurant Name]..."
      3.  **Last Day (Day ${days})**: CRITICAL REQUIREMENT:
          - The group MUST arrive back in ${origin} by ~20:00 or 21:00.
          - Calculate backwards: If arrival in ${origin} is 20:00, and travel is ${Math.ceil(travelTimeHours)}h, departure MUST be around ${Math.max(0, 20 - Math.ceil(travelTimeHours))}:00.
          - Structure: Morning Activity (if time permits before departure) -> Checkout -> "Departure for ${origin}" -> Arrival.
          - Do NOT plan a full day of sightseeing if the return travel is long.
      
      CRITICAL RULES:
      - **NO generic timings** like "Morning". Use "09:00 AM - 12:00 PM".
      - **NO generic restaurants** like "Local Eatery". Use real names.
      - **Route Logic**: Ensure the itinerary splits time appropriately between the specific destinations listed.
      - **Notes**: If special requirements (allergies, accessibility) are provided, explicitly mention how they are accommodated (e.g. "Lunch at X (nut-free options available)").

      ADDITIONAL TASK:
      Provide a detailed, engaging educational description (approx 30-50 words) for EACH of the Contextual POIs listed above.

      OUTPUT SCHEMA:
      Return ONLY valid JSON:
      {
        "itinerary": [
          { 
            "day": 1, 
            "description": "...", 
            "poi_name": "Exact Name of POI if applicable (optional)"
          },
          ...
        ],
        "poi_descriptions": [
          { "name": "Name from list", "description": "..." }
        ]
      }
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            itinerary: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  day: { type: Type.INTEGER },
                  description: { type: Type.STRING, description: "Detailed daily agenda with timings and specific restaurants." },
                  poi_name: { type: Type.STRING, description: "Exact name of a POI mentioned in this day's description, if any, that matches a Contextual POI." }
                },
                required: ['day', 'description']
              }
            },
            poi_descriptions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  description: { type: Type.STRING }
                }
              }
            }
          }
        }
      }
    });

    const json = JSON.parse(cleanJsonString(response.text));
    let it = [];
    let pd = [];

    if (json.itinerary && Array.isArray(json.itinerary)) {
      it = json.itinerary
        .sort((a: any, b: any) => a.day - b.day)
        .map((item: any) => ({
          day: item.day,
          activity: item.description,
          poi_name: item.poi_name // Capture the POI reference
        }));
    }
    
    if (json.poi_descriptions && Array.isArray(json.poi_descriptions)) {
      pd = json.poi_descriptions;
    }

    return { itinerary: it, poi_descriptions: pd };
  } catch (e) {
    console.warn("Gemini Itinerary Gen Error", e);
    return { itinerary: [], poi_descriptions: [] };
  }
}

/* ===========================
   Logic
   =========================== */

function estimateCosts(params: TripFormState, distance_km: number, days: number, planTier: 'budget' | 'balanced' | 'premium'): { breakdown: CostBreakdown } {
  const students = params.num_students;
  const providedTeachers = params.teachers ? params.teachers.split(',').filter(s => s.trim().length > 0).length : 0;
  const requiredTeachers = Math.max(1, Math.ceil(students / 15)); 
  const teachers = Math.max(providedTeachers, requiredTeachers);
  const people = students + teachers;

  let transportCostTotal = 0;
  let transportNote = '';
  
  if (params.transport_pref === 'plane') {
    transportCostTotal = people * RATES.flight_per_person_avg;
    transportNote = `Flights for ${people} pax @ ~${RATES.flight_per_person_avg} EUR`;
  } else if (params.transport_pref === 'train') {
    transportCostTotal = people * RATES.train_per_person_avg;
    transportNote = `Trains for ${people} pax @ ~${RATES.train_per_person_avg} EUR`;
  } else if (params.transport_pref === 'ferry') {
    transportCostTotal = people * 80;
    transportNote = `Ferry for ${people} pax @ ~80 EUR`;
  } else if (params.transport_pref === 'private_car') {
    transportCostTotal = distance_km * 0.30 * 2;
    transportNote = `Private Car ~${distance_km.toFixed(0)} km (round-trip) @ 0.30 EUR/km`;
  } else {
    const buses = Math.max(1, Math.ceil(people / RATES.bus_capacity));
    const totalDist = (distance_km * 2) + (days * 50);
    transportCostTotal = buses * totalDist * RATES.bus_cost_per_km_per_bus;
    transportNote = `${buses} bus(es) × ~${totalDist.toFixed(0)} km (round-trip + local) × ${RATES.bus_cost_per_km_per_bus} EUR/km`;
  }

  let accomRate = RATES.accommodation_per_person_per_night_balanced;
  if (planTier === 'budget') accomRate = RATES.accommodation_per_person_per_night_budget;
  if (planTier === 'premium') accomRate = RATES.accommodation_per_person_per_night_premium;

  const nights = Math.max(0, days - 1);
  const accomTotal = accomRate * people * nights;
  const mealsTotal = RATES.meals_per_person_per_day * people * days;
  const entryTotal = (RATES.entry_fee_per_student_avg * students) + (RATES.entry_fee_per_student_avg * teachers * RATES.teacher_discount);
  
  // Refined Extras Breakdown
  const activityFees = safe(entryTotal * 0.2); // Additional workshops/guides approx 20% of entry
  const localTransport = safe(days * people * 5); // Approx 5 EUR/day/person for local transit/metro
  const contingency = safe((transportCostTotal + accomTotal + mealsTotal + entryTotal) * 0.05); // 5% contingency
  
  const extras = safe(activityFees + localTransport + contingency);
  const total = safe(transportCostTotal + accomTotal + mealsTotal + entryTotal + extras);
  const perStudent = safe(total / Math.max(1, students));

  return {
    breakdown: {
      transport: safe(transportCostTotal),
      accommodation: safe(accomTotal),
      meals: safe(mealsTotal),
      entry_fees: safe(entryTotal),
      activity_fees: activityFees,
      local_transport: localTransport,
      contingency: contingency,
      total: total,
      per_student: perStudent,
      transport_note: transportNote,
      accom_rate_per_person: accomRate,
      accom_note: `${nights} nights @ ~${accomRate} EUR/person (${planTier})`
    }
  };
}

function computeReliability(sources: any[]) {
  if (!sources || !sources.length) return 42;
  let score = 40;
  sources.forEach(s => {
    if (s.source === 'google-maps') score += 20; 
    if (s.source === 'opentripmap') score += 15;
    if (s.source === 'ors') score += 12;
    if (s.source === 'wikidata') score += 10;
    if (s.source === 'geonames') score += 6;
    if (s.verified) score += 8;
    if (s.url && /^https:\/\//i.test(s.url)) score += 6;
  });
  return Math.min(98, Math.round(score));
}

export async function buildThreePlans(formData: TripFormState, forceTemplates = false): Promise<PlannerResult> {
  const dep = parseDateNormalized(formData.dep_date);
  const ret = parseDateNormalized(formData.ret_date);
  if (!dep || !ret) throw new Error("Invalid dates.");
  if (dep > ret) throw new Error("Departure date must be before return date.");
  const days = daysInclusive(dep, ret);
  if (formData.trip_type.toLowerCase().includes('multi') && days < 2) throw new Error("Multi-day trip must be at least 2 days.");

  let originGeo: GeoLocation | null = null;
  if (formData.origin && formData.origin.trim() !== '') {
    originGeo = await geocodeGeoNames(formData.origin) || await geocodeORS(formData.origin);
  }
  if (!originGeo) {
    originGeo = { lat: IDSS_COORDS.lat, lng: IDSS_COORDS.lng, name: 'IDSS Sarajevo', source: 'default', url: null };
  }

  let complexRouteCandidate: { stops: GeoLocation[] } | null = null;
  let candidates: { city: string; country?: string; lat?: number; lng?: number }[] = [];

  const validDestinations = formData.destinations.filter(d => d.trim().length > 0);

  if (validDestinations.length > 0) {
    const resolvedStops: GeoLocation[] = [];
    for (const dest of validDestinations) {
        const ge = await geocodeGeoNames(dest) || await geocodeORS(dest);
        if (ge) {
            resolvedStops.push(ge);
        }
    }
    if (resolvedStops.length > 0) {
        complexRouteCandidate = { stops: resolvedStops };
    }
  } else {
    // Suggest destinations
    // Only attempt Gemini if API Key is available
    const apiKey = getGeminiApiKey();
    if (!forceTemplates && apiKey) {
      const prompt = `Suggest 3 distinct and best cities/regions for a ${formData.trip_type} field trip for grade ${formData.grade_level} students. Focus: ${formData.focus}. Scope: ${formData.scope}. Origin: ${originGeo.name}.`;
      const geminiSuggs = await getGeminiSuggestions(prompt, originGeo.lat, originGeo.lng);
      
      for (const s of geminiSuggs.slice(0, 4)) {
         const ge = await geocodeGeoNames(s.label) || await geocodeORS(s.label);
         if (ge) {
           if (!candidates.some(c => c.city === ge.name)) {
             candidates.push({ city: ge.name, lat: ge.lat, lng: ge.lng });
           }
         }
      }
    }

    if (candidates.length === 0) {
      Object.keys(SUGGESTED_CITIES).forEach(c => {
        SUGGESTED_CITIES[c].forEach(city => candidates.push({ city, country: c }));
      });
      if (candidates.length > 12) candidates = candidates.slice(0, 12);
    }
  }

  const tiers = ['budget', 'balanced', 'premium'] as const;
  const plansOut: TripPlan[] = [];

  if (complexRouteCandidate) {
      for (const tier of tiers) {
          const stops = complexRouteCandidate.stops;
          const destinationTitle = stops.map(s => s.name).join(' -> ');
          const title = `${destinationTitle} — ${tier.charAt(0).toUpperCase() + tier.slice(1)}`;
          
          const coords: [number, number][] = [[originGeo.lng, originGeo.lat]];
          stops.forEach(s => coords.push([s.lng, s.lat]));
          
          let routeInfo = await orsRouteDistance(coords);
          
          if (!routeInfo || !routeInfo.distance_m) {
              let totalMeters = 0;
              let poly: [number, number][] = [[originGeo.lat, originGeo.lng]];
              let prev = originGeo;
              for (const s of stops) {
                  totalMeters += haversineDistance(prev.lat, prev.lng, s.lat, s.lng);
                  poly.push([s.lat, s.lng]);
                  prev = s;
              }
              routeInfo = {
                  distance_m: totalMeters,
                  duration_s: (totalMeters / 50000) * 3600,
                  polyline: poly
              };
          }

          const distance_km = (routeInfo.distance_m || 0) / 1000;
          const travel_time_h = (routeInfo.duration_s || 0) / 3600;
          
          if (travel_time_h * 2 > (days * 9)) {
             throw new Error(`Itinerary impossible: Estimated driving time (${Math.round(travel_time_h * 2)}h round-trip) exceeds available days (${days}). Please add more days or reduce destinations.`);
          }

          const cost = estimateCosts(formData, distance_km, Math.max(1, days), tier);

          let allPois: Poi[] = [];
          if (!forceTemplates) {
              for (const stop of stops) {
                  const otmPois = await fetchOpenTripMapPOIs(stop.lat, stop.lng, 5000); 
                  allPois = [...allPois, ...otmPois];
                  if (otmPois.length < 2) {
                      const wiki = await wikidataPOIs(stop.lat, stop.lng, 10, formData.focus);
                      allPois = [...allPois, ...wiki];
                  }
              }
          }

          let itinerary: ItineraryDay[] = [];
          let poiDescriptions: Map<string, string> = new Map();

          if (!forceTemplates) {
              const generated = await generateGeminiItinerary(
                  stops.map(s => s.name),
                  days,
                  formData.grade_level,
                  formData.focus,
                  tier,
                  originGeo.name,
                  travel_time_h,
                  allPois.map(p => ({ label: p.label, url: p.url })),
                  formData.notes
              );
              if (generated.itinerary.length > 0) itinerary = generated.itinerary;
              generated.poi_descriptions.forEach(d => poiDescriptions.set(d.name, d.description));
          }

          const sources: SourceLink[] = [];
          allPois.slice(0, 15).forEach(p => {
              let desc = poiDescriptions.get(p.label);
              if (!desc) {
                  for (const [key, val] of poiDescriptions.entries()) {
                      if (key.includes(p.label) || p.label.includes(key)) {
                          desc = val; break;
                      }
                  }
              }
              if (p.url || desc) {
                  sources.push({ 
                      url: p.url, 
                      title: p.label, 
                      source: p.source, 
                      verified: !!p.url, 
                      description: desc,
                      lat: p.lat,
                      lng: p.lng
                  });
              }
          });
          sources.push({ url: originGeo.url, title: originGeo.name, source: originGeo.source, verified: !!originGeo.url, description: 'Departure', lat: originGeo.lat, lng: originGeo.lng });
          const uniqueSources = sources.filter((s, index, self) => index === self.findIndex((t) => (t.url === s.url && t.title === s.title)));

          plansOut.push({
              title,
              reliability: computeReliability(uniqueSources),
              destination: destinationTitle,
              number_of_days: days,
              itinerary: itinerary.length ? itinerary : [{ day: 1, activity: 'Itinerary generation failed.' }],
              estimated_cost_per_student: `${cost.breakdown.per_student} EUR`,
              cost_breakdown: cost.breakdown,
              distance_km: safe(distance_km),
              travel_time_h: safe(travel_time_h),
              accompanying_teachers: formData.teachers,
              why: `Multi-stop route fitting focus: ${formData.focus}.`,
              sources: uniqueSources.slice(0, 8),
              polyline: routeInfo.polyline
          });
      }

  } else {
      const enriched = [];
      for (const c of candidates) {
          let ge: GeoLocation | null = null;
          if (c.lat && c.lng) {
              ge = { lat: c.lat, lng: c.lng, name: c.city, source: 'input', url: null };
          } else {
              ge = await geocodeGeoNames(c.city + (c.country ? ', ' + c.country : '')) || await geocodeORS(c.city);
          }
          if (!ge) continue;

          let pois: Poi[] = [];
          if (!forceTemplates) {
              const otm = await fetchOpenTripMapPOIs(ge.lat, ge.lng, 8000);
              pois = [...otm];
              if (pois.length < 5) {
                  const wiki = await wikidataPOIs(ge.lat, ge.lng, 15, formData.focus);
                  wiki.forEach(w => { if (!pois.some(p => p.label === w.label)) pois.push(w); });
              }
          }
          enriched.push({ city: ge.name, lat: ge.lat, lng: ge.lng, pois: pois.slice(0, 10) });
          if (enriched.length >= 3) break; 
      }

      const chosen = [];
      if (enriched.length >= 3) {
          chosen.push(enriched[0], enriched[1], enriched[2]);
      } else {
          for (const e of enriched) chosen.push(e);
          if (chosen.length === 0) {
             chosen.push({ city: 'Sarajevo, BiH', lat: 43.8563, lng: 18.4131, pois: [] });
          }
          while(chosen.length < 3) chosen.push(chosen[0]);
      }

      for (let i = 0; i < 3; i++) {
          const tier = tiers[i];
          const cand = chosen[i];
          const title = `${cand.city} — ${tier.charAt(0).toUpperCase() + tier.slice(1)}`;

          let routeInfo = await orsRouteDistance([[originGeo.lng, originGeo.lat], [cand.lng, cand.lat]]);
          if (!routeInfo || !routeInfo.distance_m) {
              const m = haversineDistance(originGeo.lat, originGeo.lng, cand.lat, cand.lng);
              routeInfo = { distance_m: m, duration_s: (m/50000)*3600, polyline: [[originGeo.lat, originGeo.lng], [cand.lat, cand.lng]] };
          }
          
          const distance_km = (routeInfo.distance_m || 0) / 1000;
          const travel_time_h = (routeInfo.duration_s || 0) / 3600;
          
          const cost = estimateCosts(formData, distance_km, Math.max(1, days), tier);

          let itinerary: ItineraryDay[] = [];
          let poiDescriptions: Map<string, string> = new Map();

          if (!forceTemplates) {
              const generated = await generateGeminiItinerary(
                  [cand.city],
                  days,
                  formData.grade_level,
                  formData.focus,
                  tier,
                  originGeo.name,
                  travel_time_h, 
                  cand.pois.map(p => ({ label: p.label, url: p.url })),
                  formData.notes
              );
              if (generated.itinerary.length > 0) itinerary = generated.itinerary;
              generated.poi_descriptions.forEach(d => poiDescriptions.set(d.name, d.description));
          }

          const sources: SourceLink[] = [];
          cand.pois.forEach(p => {
              let desc = poiDescriptions.get(p.label);
              if (!desc) {
                  for (const [key, val] of poiDescriptions.entries()) {
                      if (key.includes(p.label) || p.label.includes(key)) { desc = val; break; }
                  }
              }
              if (p.url || desc) sources.push({ 
                  url: p.url, 
                  title: p.label, 
                  source: p.source, 
                  verified: !!p.url, 
                  description: desc,
                  lat: p.lat, // Pass coords
                  lng: p.lng  // Pass coords
              });
          });
          sources.push({ url: originGeo.url, title: originGeo.name, source: originGeo.source, verified: !!originGeo.url, description: 'Departure', lat: originGeo.lat, lng: originGeo.lng });
          const uniqueSources = sources.filter((s, index, self) => index === self.findIndex((t) => (t.url === s.url && t.title === s.title)));

          plansOut.push({
              title,
              reliability: computeReliability(uniqueSources),
              destination: cand.city,
              number_of_days: days,
              itinerary: itinerary.length ? itinerary : [{ day: 1, activity: 'Fallback itinerary.' }],
              estimated_cost_per_student: `${cost.breakdown.per_student} EUR`,
              cost_breakdown: cost.breakdown,
              distance_km: safe(distance_km),
              travel_time_h: safe(travel_time_h),
              accompanying_teachers: formData.teachers,
              why: `Fits focus: ${formData.focus}.`,
              sources: uniqueSources.slice(0, 6),
              polyline: routeInfo.polyline
          });
      }
  }

  return { plans: plansOut, origin: originGeo };
}