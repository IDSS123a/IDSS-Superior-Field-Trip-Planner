import { GoogleGenAI, Type } from "@google/genai";
import { GEONAMES_USER, ORS_KEY, OPENTRIPMAP_KEY, RATES, SUGGESTED_CITIES, IDSS_COORDS } from '../constants';
import { TripFormState, PlannerResult, TripPlan, GeoLocation, Poi, CostBreakdown, ItineraryDay, SourceLink } from '../types';

/* ===========================
   Utilities
   =========================== */

export function normalizeDate(input: string): string | null {
  if (!input) return null;
  let s = String(input).trim();
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
  
  // Filter for touristy things. 'interesting_places' covers museums, historic, architecture, etc.
  const kinds = 'interesting_places'; 
  // Rate: 1, 2, 3. 3 is most popular. We use 2 to get a good mix of popular sites.
  const rate = '2';
  
  const url = `https://api.opentripmap.com/0.1/en/places/radius?radius=${radius_m}&lon=${lng}&lat=${lat}&kinds=${kinds}&rate=${rate}&format=json&limit=15&apikey=${OPENTRIPMAP_KEY}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('OTM error ' + res.status);
    const data = await res.json();
    
    // Data is array of objects
    return data.map((item: any) => ({
      label: item.name,
      lat: item.point.lat,
      lng: item.point.lon,
      // Construct a direct link to OpenTripMap card for this object
      url: `https://opentripmap.com/en/card/${item.xid}`, 
      source: 'opentripmap'
    })).filter((p: any) => p.label && p.label.trim().length > 0);
  } catch (e) {
    console.warn('OpenTripMap fail', e);
    return [];
  }
}

async function orsRouteDistance(startLon: number, startLat: number, endLon: number, endLat: number) {
  if (!ORS_KEY) return null;
  try {
    const res = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': ORS_KEY },
      body: JSON.stringify({ coordinates: [[startLon, startLat], [endLon, endLat]] })
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
  // Ensure API key is present
  if (typeof process === 'undefined' || !process.env || !process.env.API_KEY) {
    return [];
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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
          // We temporarily set lat/lng to 0, to be resolved via geocoding later
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
  destination: string,
  days: number,
  grade: string,
  focus: string,
  tier: string,
  origin: string,
  poiList: { label: string, url: string | null }[]
): Promise<GenItineraryResult> {
  if (typeof process === 'undefined' || !process.env || !process.env.API_KEY) {
    return { itinerary: [], poi_descriptions: [] };
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    // Only use unique names
    const uniquePois = poiList.filter((poi, index, self) => 
      index === self.findIndex((t) => (t.label === poi.label))
    ).slice(0, 12);

    const poiContext = uniquePois.map(p => `- ${p.label}${p.url ? ` (URL: ${p.url})` : ''}`).join('\n');
    
    const prompt = `
      You are a world-class educational travel specialist. Create a deeply detailed, logistical, and educational day-by-day itinerary for a ${days}-day school trip to ${destination}, departing from ${origin}.

      PARAMETERS:
      - Grade Level: ${grade}
      - Primary Focus: ${focus}
      - Budget Tier: ${tier} (STRICTLY ADHERE TO THIS FOR DINING CHOICES)
      
      CONTEXTUAL POIs (Include these if relevant):
      ${poiContext}

      STRICT OUTPUT FORMAT:
      For EVERY day, provide a chronological list of activities.
      EVERY activity block MUST start with a specific time range in this exact format: "HH:MM AM - HH:MM PM".

      CONTENT REQUIREMENTS:
      1.  **Day 1 (Travel & Arrival)**:
          - "08:00 AM - Departure from ${origin}..."
          - arrival, check-in.
          - "07:00 PM - 09:00 PM - Welcome Dinner at [Specific Restaurant Name]..."
      2.  **Full Days**:
          - **Morning**: "09:00 AM - 12:00 PM - Visit [Specific Site]..."
          - **Lunch**: "12:00 PM - 01:30 PM - Lunch at [Specific Restaurant Name]..." (MUST be a real, specific place suitable for students and the budget tier: ${tier}).
          - **Afternoon**: "02:00 PM - 05:00 PM - Visit [Specific Site]..."
          - **Evening**: "06:30 PM - 08:30 PM - Dinner at [Specific Restaurant Name]..."
      3.  **Last Day**: Morning activity, checkout, return journey.
      
      CRITICAL RULES:
      - **NO generic timings** like "Morning" or "Afternoon". Use "09:00 AM - 12:00 PM".
      - **NO generic restaurants** like "Local Eatery". Use real names (e.g., "Vapiano", "Sarajevski Cevapi", "Hard Rock Cafe", "University Mensa").
      - Ensure the itinerary flows logically.

      ADDITIONAL TASK:
      Provide a detailed, engaging educational description (approx 30-50 words) for EACH of the Contextual POIs listed above. Use the provided URL (if any) as context to ensure accuracy of the description, but do not simply repeat the URL.

      OUTPUT SCHEMA:
      Return ONLY valid JSON:
      {
        "itinerary": [
          { "day": 1, "description": "..." },
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
                  description: { type: Type.STRING, description: "Detailed daily agenda with timings and specific restaurants." }
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

    const json = JSON.parse(response.text || '{}');
    let it = [];
    let pd = [];

    if (json.itinerary && Array.isArray(json.itinerary)) {
      it = json.itinerary
        .sort((a: any, b: any) => a.day - b.day)
        .map((item: any) => ({
          day: item.day,
          activity: item.description
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
  // Estimate 1 teacher per 15 students minimum, or use provided list count
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
  } else {
    const buses = Math.max(1, Math.ceil(people / RATES.bus_capacity));
    // Round trip + daily local usage (approx 50km/day)
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
  const extras = safe((transportCostTotal + accomTotal + mealsTotal + entryTotal) * 0.08);
  const total = safe(transportCostTotal + accomTotal + mealsTotal + entryTotal + extras);
  const perStudent = safe(total / Math.max(1, students));

  return {
    breakdown: {
      transport: safe(transportCostTotal),
      accommodation: safe(accomTotal),
      meals: safe(mealsTotal),
      entry_fees: safe(entryTotal),
      extras: extras,
      total: total,
      per_student: perStudent,
      transport_note: transportNote,
      accom_rate_per_person: accomRate
    }
  };
}

function computeReliability(sources: any[]) {
  if (!sources || !sources.length) return 42;
  let score = 40;
  sources.forEach(s => {
    if (s.source === 'google-maps') score += 20; // High confidence for Grounded data
    if (s.source === 'opentripmap') score += 15; // Reliable secondary source
    if (s.source === 'ors') score += 12;
    if (s.source === 'wikidata') score += 10;
    if (s.source === 'geonames') score += 6;
    if (s.verified) score += 8;
    if (s.url && /^https:\/\//i.test(s.url)) score += 6;
  });
  return Math.min(98, Math.round(score));
}

export async function buildThreePlans(formData: TripFormState, forceTemplates = false): Promise<PlannerResult> {
  // 1. Validate
  const dep = parseDateNormalized(formData.dep_date);
  const ret = parseDateNormalized(formData.ret_date);
  if (!dep || !ret) throw new Error("Invalid dates.");
  if (dep > ret) throw new Error("Departure date must be before return date.");
  const days = daysInclusive(dep, ret);
  if (formData.trip_type.toLowerCase().includes('multi') && days < 2) throw new Error("Multi-day trip must be at least 2 days.");

  // 2. Geocode Origin
  let originGeo: GeoLocation | null = null;
  if (formData.origin && formData.origin.trim() !== '') {
    originGeo = await geocodeGeoNames(formData.origin) || await geocodeORS(formData.origin);
  }
  if (!originGeo) {
    originGeo = { lat: IDSS_COORDS.lat, lng: IDSS_COORDS.lng, name: 'IDSS Sarajevo', source: 'default', url: null };
  }

  // 3. Candidates (Destination Search)
  let candidates: { city: string; country?: string; lat?: number; lng?: number }[] = [];
  const destInput = formData.destination ? formData.destination.trim() : '';

  if (destInput) {
    // User provided a destination
    const ge = await geocodeGeoNames(destInput) || await geocodeORS(destInput);
    if (ge) {
      candidates.push({ city: ge.name, lat: ge.lat, lng: ge.lng });
    }
  } else {
    // Suggest destinations
    // Attempt Gemini First
    if (!forceTemplates && typeof process !== 'undefined' && process.env && process.env.API_KEY) {
      const prompt = `Suggest 3 distinct and best cities/regions for a ${formData.trip_type} field trip for grade ${formData.grade_level} students. Focus: ${formData.focus}. Scope: ${formData.scope}. Origin: ${originGeo.name}.`;
      const geminiSuggs = await getGeminiSuggestions(prompt, originGeo.lat, originGeo.lng);
      
      for (const s of geminiSuggs.slice(0, 4)) {
         // Resolve coordinates for Gemini suggestions
         const ge = await geocodeGeoNames(s.label) || await geocodeORS(s.label);
         if (ge) {
           // Avoid duplicates
           if (!candidates.some(c => c.city === ge.name)) {
             candidates.push({ city: ge.name, lat: ge.lat, lng: ge.lng });
           }
         }
      }
    }

    // Fallback to hardcoded suggestions if AI returned nothing or API Key missing
    if (candidates.length === 0) {
      Object.keys(SUGGESTED_CITIES).forEach(c => {
        SUGGESTED_CITIES[c].forEach(city => candidates.push({ city, country: c }));
      });
      // If no candidates yet (e.g. filtered out?), take slice
      if (candidates.length > 12) candidates = candidates.slice(0, 12);
    }
  }

  // 4. Enrich (Find POIs)
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
    
    // 4a. Try Gemini Maps Grounding for POIs
    if (!forceTemplates && typeof process !== 'undefined' && process.env && process.env.API_KEY) {
       const prompt = `Find 3 best educational points of interest in ${c.city} for grade ${formData.grade_level} students. Focus: ${formData.focus}.`;
       const geminiPois = await getGeminiSuggestions(prompt, ge.lat, ge.lng);
       
       for (const gp of geminiPois) {
         // Resolve coords for POI. Append city name to ensure correct location.
         const searchQuery = `${gp.label}, ${c.city}`;
         const pGeo = await geocodeORS(searchQuery) || await geocodeGeoNames(searchQuery) || await geocodeORS(gp.label);
         
         if (pGeo) {
           if (!pois.some(p => p.label === gp.label)) {
             pois.push({ 
               ...gp, 
               lat: pGeo.lat, 
               lng: pGeo.lng, 
               // Keep original Google Maps URL if available
               url: gp.url || pGeo.url
             });
           }
         }
       }
    }

    // 4b. Supplement with OpenTripMap (High Quality)
    if (!forceTemplates) {
      const otmPois = await fetchOpenTripMapPOIs(ge.lat, ge.lng, 8000);
      otmPois.forEach(o => {
        if (!pois.some(p => p.label === o.label)) pois.push(o);
      });
    }

    // 4c. Fallback with Wikidata/ORS
    if (pois.length < 2 && !forceTemplates) {
      const wikiPois = await wikidataPOIs(ge.lat, ge.lng, 18, formData.focus);
      wikiPois.forEach(w => {
        if (!pois.some(p => p.label === w.label)) pois.push(w);
      });

      if (pois.length < 2) {
        const orsPois = await orsPOIsAround(ge.lng, ge.lat, 7000);
        orsPois.forEach(o => {
          if (!pois.some(p => p.label === o.label)) pois.push(o);
        });
      }
    }

    enriched.push({ city: ge.name, lat: ge.lat, lng: ge.lng, pois: pois.slice(0, 10) });
    
    // If a specific destination was input, stop after processing it.
    if (destInput && enriched.length >= 1) break; 
  }

  // 5. Select 3 Plans
  const chosen = [];
  if (enriched.length >= 3) {
    chosen.push(enriched[0]);
    chosen.push(enriched[Math.floor(enriched.length / 2)]);
    chosen.push(enriched[enriched.length - 1]);
  } else if (enriched.length > 0) {
    // Fill with available
    for (const e of enriched) chosen.push(e);
    // Pad if needed
    while (chosen.length < 3) chosen.push(enriched[0]); 
  } else {
    // Ultimate Fallback
    chosen.push({ city: 'Sarajevo, BiH', lat: 43.8563, lng: 18.4131, pois: [] });
    chosen.push({ city: 'Mostar, BiH', lat: 43.3438, lng: 17.8078, pois: [] });
    chosen.push({ city: 'Tuzla, BiH', lat: 44.5375, lng: 18.6735, pois: [] });
  }

  // 6. Build Plans
  const tiers = ['budget', 'balanced', 'premium'] as const;
  const plansOut: TripPlan[] = [];

  for (let i = 0; i < 3; i++) {
    const tier = tiers[i];
    const cand = chosen[i];
    const title = `${cand.city} — ${tier.charAt(0).toUpperCase() + tier.slice(1)}`;
    
    // Route
    let routeInfo = await orsRouteDistance(originGeo.lng, originGeo.lat, cand.lng, cand.lat);
    if (!routeInfo || !routeInfo.distance_m) {
      const meters = haversineDistance(originGeo.lat, originGeo.lng, cand.lat, cand.lng);
      routeInfo = { 
        distance_m: meters, 
        duration_s: (meters / 50000) * 3600, 
        polyline: [[originGeo.lat, originGeo.lng], [cand.lat, cand.lng]] 
      };
    }

    const distance_km = (routeInfo.distance_m || 0) / 1000;
    const poiA = cand.pois[0] || { label: 'Local Cultural Site', lat: cand.lat, lng: cand.lng, url: null, source: 'template' };
    const poiB = cand.pois[1] || null;

    const cost = estimateCosts(formData, distance_km, Math.max(1, days), tier);

    // Generate Detailed Itinerary with Gemini
    let itinerary: ItineraryDay[] = [];
    let poiDescriptions: Map<string, string> = new Map();

    // Attempt to use AI to generate a rich, detailed itinerary and descriptions
    if (!forceTemplates) {
      const generated = await generateGeminiItinerary(
        cand.city,
        days,
        formData.grade_level,
        formData.focus,
        tier,
        originGeo.name,
        cand.pois.map(p => ({ label: p.label, url: p.url }))
      );
      
      if (generated.itinerary.length > 0) {
        itinerary = generated.itinerary;
      }
      if (generated.poi_descriptions.length > 0) {
        generated.poi_descriptions.forEach(d => poiDescriptions.set(d.name, d.description));
      }
    }

    // Fallback static itinerary if AI failed or templates requested
    if (itinerary.length === 0) {
      itinerary.push({ day: 1, activity: `Travel from ${originGeo.name} to ${cand.city} (~${distance_km.toFixed(1)} km). Check-in & Orientation.` });
      if (days >= 2) itinerary.push({ day: 2, activity: `Visit: ${poiA.label} — Guided educational tour (Focus: ${formData.focus}).` });
      if (days >= 3 && poiB) itinerary.push({ day: 3, activity: `Visit: ${poiB.label} — Workshop / Hands-on activity.` });
      for (let d = itinerary.length + 1; d <= days; d++) itinerary.push({ day: d, activity: 'Reflection, group activities, free time.' });
    }

    const sources: SourceLink[] = [];
    // Add verified POIs to sources list
    cand.pois.forEach(p => {
      // Attempt to find description by exact match or fuzzy check
      let desc = poiDescriptions.get(p.label);
      // Fallback: look for partial match in keys
      if (!desc) {
          for (const [key, val] of poiDescriptions.entries()) {
            if (key.includes(p.label) || p.label.includes(key)) {
              desc = val;
              break;
            }
          }
      }
      
      // Add to sources if it has URL OR if we have a description generated by AI
      if (p.url || desc) {
        sources.push({ 
          url: p.url, 
          title: p.label, 
          source: p.source, 
          verified: !!p.url,
          description: desc
        });
      }
    });

    if (sources.length === 0 && poiA.url) {
      sources.push({ url: poiA.url, title: poiA.label, source: poiA.source, verified: true });
    }
    
    // Always add origin
    sources.push({ url: originGeo.url, title: originGeo.name, source: originGeo.source, verified: !!originGeo.url, description: 'Departure point' });

    // De-duplicate sources
    const uniqueSources = sources.filter((s, index, self) => 
      index === self.findIndex((t) => (t.url === s.url && t.title === s.title))
    );

    plansOut.push({
      title,
      reliability: computeReliability(uniqueSources),
      destination: cand.city,
      number_of_days: days,
      itinerary,
      estimated_cost_per_student: `${cost.breakdown.per_student} EUR`,
      cost_breakdown: cost.breakdown,
      distance_km: safe(distance_km),
      travel_time_h: safe((routeInfo.duration_s || 0) / 3600),
      accompanying_teachers: formData.teachers,
      why: `Fits focus: ${formData.focus}. Tier: ${tier}.`,
      sources: uniqueSources.slice(0, 6), // Limit to top 6 sources
      polyline: routeInfo.polyline
    });
  }

  return { plans: plansOut, origin: originGeo };
}