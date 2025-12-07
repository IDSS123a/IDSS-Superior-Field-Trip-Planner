import React, { useState, useCallback, useRef } from 'react';
import MapView from './components/MapView';
import { buildThreePlans, parseDateNormalized } from './services/locationService';
import { TripFormState, PlannerResult, TripPlan } from './types';

declare const html2pdf: any;

function App() {
  const [form, setForm] = useState<TripFormState>({
    origin: '',
    destinations: [''], 
    scope: 'regional',
    trip_type: 'Multi-day excursion',
    grade_level: '9',
    num_students: 14,
    teachers: 'Anes Memić, Victoria Bartz',
    transport_pref: 'bus',
    dep_date: '2025-09-21', 
    ret_date: '2025-09-25', 
    budget: '',
    focus: 'kulturno nasljeđe, obrazovanje, zabava',
    notes: ''
  });

  const [loading, setLoading] = useState(false);
  const [mapLoadingId, setMapLoadingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<PlannerResult | null>(null);
  const [focusedPlan, setFocusedPlan] = useState<number | null>(null);
  const [focusedLocation, setFocusedLocation] = useState<{ lat: number; lng: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setForm(prev => ({ ...prev, [name]: value }));
    if (validationErrors[name]) {
      setValidationErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[name];
        return newErrors;
      });
    }
  };

  const handleDestinationChange = (index: number, value: string) => {
    const newDestinations = [...form.destinations];
    newDestinations[index] = value;
    setForm(prev => ({ ...prev, destinations: newDestinations }));
    if (value.trim() !== '' && form.scope === 'regional') {
        setForm(prev => ({ ...prev, scope: 'specific', destinations: newDestinations }));
    }
    if (validationErrors.destinations) {
        setValidationErrors(prev => { const e = {...prev}; delete e.destinations; return e; });
    }
  };

  const addDestination = () => {
    setForm(prev => ({ ...prev, destinations: [...prev.destinations, ''] }));
  };

  const removeDestination = (index: number) => {
    if (form.destinations.length === 1) {
        handleDestinationChange(0, '');
        return;
    }
    const newDestinations = form.destinations.filter((_, i) => i !== index);
    setForm(prev => ({ ...prev, destinations: newDestinations }));
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    const hasValidDest = form.destinations.some(d => d.trim().length > 0);
    if (form.scope === 'specific' && !hasValidDest) {
      errors.destinations = 'At least one destination is required for "Specific destination" scope.';
    }
    if (!form.grade_level.trim()) errors.grade_level = 'Grade level is required.';
    if (!form.teachers.trim()) errors.teachers = 'Accompanying teachers are required.';
    if (!form.focus.trim()) errors.focus = 'Educational focus is required.';
    if (form.num_students < 1) errors.num_students = 'Number of students must be at least 1.';

    const d1 = parseDateNormalized(form.dep_date);
    const d2 = parseDateNormalized(form.ret_date);

    if (!d1) errors.dep_date = 'Invalid date.';
    if (!d2) errors.ret_date = 'Invalid date.';

    if (d1 && d2) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (d1 < today) {
        errors.dep_date = 'Departure date cannot be in the past.';
      }
      if (d1 > d2) {
        errors.ret_date = 'Return date cannot be before departure date.';
      } else {
        const diffTime = Math.abs(d2.getTime() - d1.getTime());
        const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1;
        if (form.trip_type === 'Multi-day excursion' && diffDays < 2) {
          errors.ret_date = 'Multi-day excursion requires at least 2 days.';
        }
        if (form.trip_type === 'One-day excursion' && diffDays > 1) {
          errors.ret_date = 'One-day excursion must start and end on the same day.';
        }
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleGenerate = async (forceTemplates: boolean) => {
    if (!validateForm()) {
      setError("Please fix the validation errors highlighted below.");
      return;
    }
    setLoading(true);
    setError(null);
    setFocusedPlan(null);
    setFocusedLocation(null);
    try {
      const res = await buildThreePlans(form, forceTemplates);
      setResult(res);
    } catch (err: any) {
      setError(err.message || "Unknown error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleSavePlan = (plan: TripPlan) => {
    try {
      const savedStr = localStorage.getItem('idss_saved_plans');
      let savedPlans: TripPlan[] = savedStr ? JSON.parse(savedStr) : [];
      const isDuplicate = savedPlans.some(p => p.title === plan.title && p.destination === plan.destination && p.distance_km === plan.distance_km);
      if (isDuplicate) {
        alert("This plan is already saved.");
        return;
      }
      savedPlans.push(plan);
      localStorage.setItem('idss_saved_plans', JSON.stringify(savedPlans));
      alert("Plan saved to Browser Storage!");
    } catch (e) {
      console.error("Error saving plan:", e);
      alert("Failed to save plan. Storage might be full.");
    }
  };

  const handleExportJson = (plan: TripPlan) => {
    const dataStr = JSON.stringify(plan, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `IDSS_Plan_${plan.destination.replace(/\s+/g, '_')}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleLoadSavedPlans = () => {
    try {
      const savedStr = localStorage.getItem('idss_saved_plans');
      if (!savedStr) {
        alert("No plans found in Browser Storage.");
        return;
      }
      const savedPlans: TripPlan[] = JSON.parse(savedStr);
      if (savedPlans.length === 0) {
        alert("No plans found in Browser Storage.");
        return;
      }
      setResult({ origin: null, plans: savedPlans });
      setFocusedPlan(null);
      setFocusedLocation(null);
      setError(null);
    } catch (e) {
      console.error("Error loading plans:", e);
      setError("Failed to load saved plans.");
    }
  };

  const handleFileLoadClick = () => {
    if (fileInputRef.current) {
        fileInputRef.current.click();
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const content = e.target?.result as string;
            const plan = JSON.parse(content);
            // Basic validation
            if (!plan.itinerary || !plan.cost_breakdown) {
                throw new Error("Invalid plan file format");
            }
            setResult({ origin: null, plans: [plan] });
            setFocusedPlan(null);
            setError(null);
            alert("Plan loaded from file successfully!");
        } catch (err) {
            console.error("Error parsing file", err);
            alert("Failed to load plan. Invalid file format.");
        }
    };
    reader.readAsText(file);
    // Reset input
    event.target.value = '';
  };

  const handleExportPDF = () => {
    const element = document.getElementById('export-container');
    if (typeof html2pdf === 'undefined') {
      alert("PDF library is not loaded. Please check your internet connection.");
      return;
    }
    if (!element) return;
    const opt = {
      margin: 10,
      filename: 'IDSS_field_trip_plans.pdf',
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 1.4 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };
    html2pdf().set(opt).from(element).save();
  };

  const handleMapPlanSelect = useCallback((index: number) => {
    setMapLoadingId(index);
    setFocusedPlan(index);
    setTimeout(() => {
        const element = document.getElementById(`plan-card-${index}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        setMapLoadingId(null);
    }, 400);
  }, []);

  const handleShowPoiOnMap = useCallback((lat: number, lng: number) => {
    setFocusedLocation({ lat, lng });
    const element = document.getElementById('leaflet-map-container');
    if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  return (
    <div className="min-h-screen bg-white p-4 md:p-8 font-sans" id="export-container">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-4 mb-8 border-b pb-6 border-slate-100">
          <img src="https://i.postimg.cc/zGfMdQfF/IDSS_Logo.png" alt="IDSS Logo" className="w-16 h-16 object-contain" />
          <div>
            <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900">IDSS — Superior Field Trip Planner</h1>
            <p className="text-sm text-slate-500">Generates 3 verified plans & full cost estimates across multiple countries.</p>
          </div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 mb-8 shadow-sm no-print">
          <h3 className="text-lg font-bold mb-4 text-slate-800">1. Unesite podatke za planiranje ekskurzije</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <InputGroup label="Polazna tačka" sub="(ostavi prazno za IDSS)" error={validationErrors.origin}>
              <input name="origin" value={form.origin} onChange={handleChange} placeholder="npr. Sarajevo" className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" aria-label="Starting Point" />
            </InputGroup>

            <div className="md:col-span-2">
              <label className={`block text-xs font-semibold mb-1 ${validationErrors.destinations ? 'text-red-600' : 'text-slate-500'}`}>
                Ruta Putovanja (Destinacije) <span className="font-normal opacity-75">(Unesite jednu ili više tačaka)</span>
              </label>
              <div className="space-y-2">
                {form.destinations.map((dest, index) => (
                  <div key={index} className="flex gap-2">
                    <input 
                      value={dest} 
                      onChange={(e) => handleDestinationChange(index, e.target.value)} 
                      placeholder={`Stop ${index + 1} (npr. ${index === 0 ? 'Zagreb' : index === 1 ? 'Trieste' : 'Roma'})`} 
                      className={`w-full p-2.5 rounded-lg border text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none ${validationErrors.destinations ? 'border-red-500' : 'border-slate-300'}`} 
                      aria-label={`Destination Stop ${index + 1}`}
                    />
                    {form.destinations.length > 1 && (
                      <button onClick={() => removeDestination(index)} className="px-3 text-slate-400 hover:text-red-500 border border-slate-200 rounded-lg bg-slate-50 font-bold" aria-label="Remove stop">×</button>
                    )}
                  </div>
                ))}
                <button onClick={addDestination} className="text-xs text-blue-600 font-bold hover:underline">+ Add Stop</button>
              </div>
              {validationErrors.destinations && <p className="text-red-500 text-[10px] mt-1 font-semibold">{validationErrors.destinations}</p>}
            </div>

            <InputGroup label="Opseg pretrage" error={validationErrors.scope}>
              <select name="scope" value={form.scope} onChange={handleChange} className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" aria-label="Search Scope">
                <option value="specific">Specific Route (Your Inputs)</option>
                <option value="regional">Suggest Destinations (Ignore inputs)</option>
              </select>
            </InputGroup>

            <InputGroup label="Tip ekskurzije" error={validationErrors.trip_type}>
              <select name="trip_type" value={form.trip_type} onChange={handleChange} className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" aria-label="Trip Type">
                <option>One-day excursion</option>
                <option>Multi-day excursion</option>
              </select>
            </InputGroup>

            <InputGroup label="Razred" error={validationErrors.grade_level}>
              <input name="grade_level" value={form.grade_level} onChange={handleChange} className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" aria-label="Grade Level" />
            </InputGroup>

            <InputGroup label="Broj učenika" error={validationErrors.num_students}>
              <input type="number" name="num_students" value={form.num_students} onChange={handleChange} className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" aria-label="Number of Students" />
            </InputGroup>

            <InputGroup label="Pratitelji (imena)" error={validationErrors.teachers}>
              <input name="teachers" value={form.teachers} onChange={handleChange} className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" aria-label="Accompanying Teachers" />
            </InputGroup>

            <InputGroup label="Prevoz" error={validationErrors.transport_pref}>
              <select name="transport_pref" value={form.transport_pref} onChange={handleChange} className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" aria-label="Transport Preference">
                <option value="bus">Bus</option>
                <option value="plane">Plane</option>
                <option value="train">Train</option>
                <option value="ferry">Ferry</option>
                <option value="private_car">Private Car</option>
                <option value="mixed">Mixed</option>
              </select>
            </InputGroup>

            <InputGroup label="Datum polaska" error={validationErrors.dep_date}>
              <input type="date" name="dep_date" value={form.dep_date} onChange={handleChange} className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" aria-label="Departure Date" />
            </InputGroup>

            <InputGroup label="Datum povratka" error={validationErrors.ret_date}>
              <input type="date" name="ret_date" value={form.ret_date} onChange={handleChange} className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" aria-label="Return Date" />
            </InputGroup>

            <InputGroup label="Budžet (opcionalno)" error={validationErrors.budget}>
              <input name="budget" value={form.budget} onChange={handleChange} placeholder="npr. 500 EUR" className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" aria-label="Budget" />
            </InputGroup>

            <div className="md:col-span-3">
               <InputGroup label="Obrazovni fokus" error={validationErrors.focus}>
                 <input name="focus" value={form.focus} onChange={handleChange} className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" aria-label="Educational Focus" />
               </InputGroup>
            </div>

            <div className="md:col-span-3">
               <InputGroup label="Trip Notes (Allergies, Special Needs)" error={validationErrors.notes}>
                 <textarea 
                    name="notes" 
                    value={form.notes} 
                    onChange={handleChange} 
                    rows={2} 
                    className="w-full p-2.5 rounded-lg border border-slate-300 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 outline-none" 
                    placeholder="E.g., Two students with peanut allergies, one wheelchair user..."
                    aria-label="Trip Notes"
                 />
               </InputGroup>
            </div>
          </div>

          {error && (
            <div role="alert" className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <strong>Error:</strong> {error}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <Button onClick={() => handleGenerate(false)} primary disabled={loading}>
              {loading ? (
                <div className="flex items-center gap-2">
                  <Spinner /> Generating...
                </div>
              ) : 'Generate 3 Plans (Live)'}
            </Button>
            <Button onClick={() => handleGenerate(true)} disabled={loading}>
              {loading ? 'Processing...' : 'Generate Templates (Offline)'}
            </Button>
            <Button onClick={handleLoadSavedPlans} disabled={loading}>
              Load Browser Saves
            </Button>
            
            {/* Hidden Input for File Loading */}
            <input 
              type="file" 
              ref={fileInputRef} 
              style={{display: 'none'}} 
              onChange={handleFileChange} 
              accept=".json"
            />
            <Button onClick={handleFileLoadClick} disabled={loading}>
              Load from File
            </Button>

            <Button onClick={() => window.print()}>Print</Button>
            <Button onClick={handleExportPDF}>Download PDF</Button>
          </div>
          <p className="mt-3 text-xs text-slate-400">Napomena: aplikacija koristi GeoNames (geokodiranje), Wikidata (POI) i OpenRouteService (rute/POI).</p>
        </div>

        <div className="mb-8 shadow-lg rounded-xl overflow-hidden border border-slate-200 relative">
           <MapView 
            origin={result?.origin || null} 
            plans={result?.plans || []} 
            focusedPlanIndex={focusedPlan}
            onPlanSelect={handleMapPlanSelect}
            isLoading={loading}
            focusedLocation={focusedLocation}
          />
          {(focusedPlan !== null || focusedLocation !== null) && (
            <button 
              onClick={() => {
                  setFocusedPlan(null);
                  setFocusedLocation(null);
              }}
              className="absolute top-4 right-4 bg-white text-slate-700 px-3 py-1.5 rounded-lg shadow-md text-sm font-bold z-[1000] hover:bg-slate-50 border border-slate-200"
              aria-label="Reset Map View"
            >
              Reset View
            </button>
          )}
        </div>

        {result && (
          <div className="grid gap-6">
            {result.plans.map((plan, idx) => (
              <PlanCard 
                key={idx} 
                id={`plan-card-${idx}`}
                plan={plan} 
                index={idx} 
                onFocus={() => handleMapPlanSelect(idx)}
                isFocused={focusedPlan === idx}
                isLoading={mapLoadingId === idx}
                onSave={handleSavePlan}
                onExport={handleExportJson}
                onShowPoi={handleShowPoiOnMap}
              />
            ))}
          </div>
        )}

        {!result && !loading && (
          <div className="text-center text-slate-400 py-12">
            No plans generated yet. Adjust inputs and click Generate.
          </div>
        )}

        <div className="mt-12 text-center text-xs text-slate-400 pb-8">
          IDSS Excursion Planner. All rights reserved.
        </div>

      </div>
    </div>
  );
}

const Spinner = () => (
  <svg className="animate-spin h-4 w-4 text-current" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
  </svg>
);

const InputGroup = ({ label, sub, error, children }: { label: string, sub?: string, error?: string, children: React.ReactNode }) => (
  <div>
    <label className={`block text-xs font-semibold mb-1 ${error ? 'text-red-600' : 'text-slate-500'}`}>
      {label} {sub && <span className={`font-normal opacity-75 ${error ? 'text-red-500' : ''}`}>{sub}</span>}
    </label>
    <div className={error ? "child-input-error" : ""}>
      {React.Children.map(children, child => {
        if (React.isValidElement(child)) {
          const props = child.props as { className?: string; [key: string]: any };
          return React.cloneElement(child, {
            className: `${props.className || ''} ${error ? 'border-red-500 ring-1 ring-red-200 focus:border-red-500 focus:ring-red-200' : ''}`
          } as any);
        }
        return child;
      })}
    </div>
    {error && <p className="text-red-500 text-[10px] mt-1 font-semibold" role="alert">{error}</p>}
  </div>
);

const Button = ({ children, primary, disabled, onClick }: { children: React.ReactNode, primary?: boolean, disabled?: boolean, onClick?: () => void }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`px-4 py-2.5 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 focus:outline-none
      ${disabled ? 'opacity-70 cursor-not-allowed' : 'hover:scale-[1.02] active:scale-[0.98]'}
      ${primary 
        ? 'bg-blue-600 text-white shadow-md hover:bg-blue-700' 
        : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
      }`}
  >
    {children}
  </button>
);

const PlanCard = ({ plan, index, onFocus, isFocused, id, isLoading, onSave, onExport, onShowPoi }: { 
    plan: TripPlan, 
    index: number, 
    onFocus: () => void, 
    isFocused: boolean, 
    id?: string, 
    isLoading?: boolean, 
    onSave: (plan: TripPlan) => void,
    onExport: (plan: TripPlan) => void,
    onShowPoi: (lat: number, lng: number) => void
}) => (
  <div 
    id={id} 
    className={`bg-white rounded-xl border-l-4 shadow-sm p-5 break-inside-avoid transition-all 
      ${isFocused 
        ? 'border-blue-600 ring-2 ring-blue-200 bg-blue-50 shadow-lg scale-[1.01]' 
        : 'border-slate-200 hover:border-blue-300'
      }`}
  >
    <div className="flex flex-wrap justify-between items-start mb-4 border-b border-slate-100 pb-4">
      <div>
        <h3 className="text-lg font-bold text-slate-900">Option {index + 1} — {plan.title}</h3>
        <p className="text-sm text-slate-500">{plan.destination}</p>
      </div>
      <div className="flex items-center gap-2">
        <button 
          onClick={() => onSave(plan)}
          className="text-xs px-3 py-1.5 rounded-md font-bold transition-colors bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border border-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          aria-label="Save plan to browser"
        >
          Save
        </button>
        <button 
          onClick={() => onExport(plan)}
          className="text-xs px-3 py-1.5 rounded-md font-bold transition-colors bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-500"
          aria-label="Export plan to file"
        >
          Export
        </button>
        <button 
          onClick={onFocus} 
          disabled={isLoading}
          className={`text-xs px-3 py-1.5 rounded-md font-bold transition-colors flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-blue-500
            ${isFocused 
              ? 'bg-blue-600 text-white' 
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          aria-label={isFocused ? "Currently viewing on map" : "Zoom to map"}
        >
          {isLoading && <Spinner />}
          {isLoading ? 'Zooming...' : (isFocused ? 'Viewing Map' : 'Zoom to Map')}
        </button>
        <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded-lg text-xs font-bold">
          Reliability: {plan.reliability}%
        </span>
      </div>
    </div>

    <div className="grid md:grid-cols-2 gap-6 text-sm">
      <div>
        <div className="mb-3">
          <span className="font-bold">Days:</span> {plan.number_of_days} &nbsp;•&nbsp; 
          <span className="font-bold">Distance:</span> {plan.distance_km} km &nbsp;•&nbsp; 
          <span className="font-bold">Travel:</span> {plan.travel_time_h.toFixed(1)} h
        </div>
        
        <div className="mb-3">
          <strong className="block text-slate-700 mb-1">Itinerary:</strong>
          <ol className="list-decimal list-inside space-y-1 text-slate-600 pl-2">
            {plan.itinerary.map(d => (
              <li key={d.day}>
                <span className="font-semibold text-slate-800">Day {d.day}:</span> {d.activity}
                {d.poi_name && (
                  <button 
                    onClick={() => {
                        const source = plan.sources.find(s => 
                            s.title.toLowerCase().includes(d.poi_name!.toLowerCase()) || 
                            d.poi_name!.toLowerCase().includes(s.title.toLowerCase())
                        );
                        if (source && source.lat && source.lng) {
                            onShowPoi(source.lat, source.lng);
                        } else {
                            alert("Coordinates for this specific location are not available.");
                        }
                    }}
                    className="ml-2 text-[10px] text-blue-600 border border-blue-200 bg-blue-50 px-1.5 rounded hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    title="Show location on map"
                    aria-label={`Show ${d.poi_name} on map`}
                  >
                    📍 Map
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>

        <div className="mb-3">
          <strong className="block text-slate-700 mb-1">Why this fits:</strong>
          <p className="text-slate-600">{plan.why}</p>
        </div>
        
        <div>
          <strong className="block text-slate-700 mb-1">Teachers:</strong>
          <p className="text-slate-600">{plan.accompanying_teachers}</p>
        </div>
      </div>

      <div className="bg-slate-50 rounded-lg p-4 border border-slate-100">
        <div className="mb-2 flex justify-between items-center">
          <span className="font-bold text-slate-700">Cost per Student:</span>
          <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full font-bold">
            {plan.estimated_cost_per_student}
          </span>
        </div>
        
        <div className="space-y-1 text-slate-500 text-xs mt-3">
          <div className="flex justify-between">
            <span>Transport:</span>
            <span>{plan.cost_breakdown.transport} EUR</span>
          </div>
          <div className="text-[10px] text-slate-400 pl-2 italic">{plan.cost_breakdown.transport_note}</div>
          
          <div className="flex justify-between">
            <span>Accommodation:</span>
            <span>{plan.cost_breakdown.accommodation} EUR</span>
          </div>
          <div className="text-[10px] text-slate-400 pl-2 italic">{plan.cost_breakdown.accom_note}</div>

          <div className="flex justify-between">
            <span>Meals:</span>
            <span>{plan.cost_breakdown.meals} EUR</span>
          </div>
          <div className="flex justify-between">
            <span>Entry Fees:</span>
            <span>{plan.cost_breakdown.entry_fees} EUR</span>
          </div>
          
          <div className="pt-2 mt-2 border-t border-slate-200">
            <strong className="block text-slate-600 mb-1">Extras & Contingency:</strong>
            <div className="flex justify-between pl-2">
               <span>Activity Fees:</span>
               <span>{plan.cost_breakdown.activity_fees} EUR</span>
            </div>
            <div className="flex justify-between pl-2">
               <span>Local Transport:</span>
               <span>{plan.cost_breakdown.local_transport} EUR</span>
            </div>
            <div className="flex justify-between pl-2">
               <span>Contingency (5%):</span>
               <span>{plan.cost_breakdown.contingency} EUR</span>
            </div>
          </div>

          <div className="flex justify-between font-bold text-slate-700 pt-2 border-t border-slate-200 mt-1">
            <span>Total Trip Cost:</span>
            <span>{plan.cost_breakdown.total} EUR</span>
          </div>
        </div>
      </div>
    </div>

    {plan.sources && plan.sources.length > 0 && (
      <div className="mt-4 pt-4 border-t border-slate-100">
        <h4 className="text-xs font-bold text-slate-500 uppercase mb-3 tracking-wide">Educational Resources & Key Sites</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {plan.sources.map((s, i) => (
            <div key={i} className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-col transition hover:shadow-md hover:border-blue-200">
              <div className="flex justify-between items-start mb-1">
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer" className="font-bold text-sm text-blue-600 hover:underline truncate block">
                      {s.title} ↗
                    </a>
                  ) : (
                    <span className="font-bold text-sm text-slate-700 truncate block">{s.title}</span>
                  )}
                  {s.lat && s.lng && (
                      <button 
                        onClick={() => onShowPoi(s.lat!, s.lng!)} 
                        title="Show on Map"
                        className="text-xs text-slate-400 hover:text-blue-600 p-1 hover:bg-slate-100 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                        aria-label={`Show ${s.title} on map`}
                      >
                        📍 Map
                      </button>
                  )}
              </div>
              
              {s.description ? (
                 <p className="text-xs text-slate-600 mt-1 leading-relaxed">{s.description}</p>
              ) : (
                 <span className="text-[10px] text-slate-400 italic mt-1">Verified location</span>
              )}
            </div>
          ))}
        </div>
      </div>
    )}
  </div>
);

export default App;