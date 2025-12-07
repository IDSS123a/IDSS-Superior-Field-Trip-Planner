export interface GeoLocation {
  lat: number;
  lng: number;
  name: string;
  source: string;
  url: string | null;
}

export interface Poi {
  label: string;
  lat: number;
  lng: number;
  url: string | null;
  source: string;
}

export interface TripFormState {
  origin: string;
  destinations: string[]; 
  scope: 'specific' | 'regional';
  trip_type: string;
  grade_level: string;
  num_students: number;
  teachers: string;
  transport_pref: 'bus' | 'plane' | 'train' | 'ferry' | 'private_car' | 'mixed';
  dep_date: string;
  ret_date: string;
  budget: string;
  focus: string;
  notes: string;
}

export interface CostBreakdown {
  transport: number;
  accommodation: number;
  meals: number;
  entry_fees: number;
  activity_fees: number; // New
  local_transport: number; // New
  contingency: number; // New (formerly generic extras)
  total: number;
  per_student: number;
  transport_note: string;
  accom_rate_per_person: number;
  accom_note: string; // New: detailed rate info
}

export interface ItineraryDay {
  day: number;
  activity: string;
  poi_name?: string;
}

export interface SourceLink {
  url: string | null;
  title: string;
  source: string;
  verified: boolean;
  description?: string;
  lat?: number;
  lng?: number;
}

export interface TripPlan {
  title: string;
  reliability: number;
  destination: string;
  number_of_days: number;
  itinerary: ItineraryDay[];
  estimated_cost_per_student: string;
  cost_breakdown: CostBreakdown;
  distance_km: number;
  travel_time_h: number;
  accompanying_teachers: string;
  why: string;
  sources: SourceLink[];
  polyline: [number, number][];
}

export interface PlannerResult {
  plans: TripPlan[];
  origin: GeoLocation | null;
}