import React, { useEffect, useRef } from 'react';
import { GeoLocation, TripPlan } from '../types';

declare global {
  interface Window {
    L: any;
  }
}

interface MapViewProps {
  origin: GeoLocation | null;
  plans: TripPlan[];
  focusedPlanIndex?: number | null;
  onPlanSelect?: (index: number) => void;
  isLoading?: boolean;
  focusedLocation?: { lat: number; lng: number } | null;
}

const MapView: React.FC<MapViewProps> = ({ origin, plans, focusedPlanIndex, onPlanSelect, isLoading, focusedLocation }) => {
  const mapRef = useRef<any>(null);
  const layerGroupRef = useRef<any>(null);
  const mapContainerId = 'leaflet-map-container';

  useEffect(() => {
    const L = window.L;
    if (!L) return;

    // Initialize Map if not exists
    if (!mapRef.current) {
      mapRef.current = L.map(mapContainerId).setView([43.8563, 18.4131], 6);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(mapRef.current);
      layerGroupRef.current = L.layerGroup().addTo(mapRef.current);
    }

    const map = mapRef.current;
    
    // Resize map when container size changes or loading finishes
    setTimeout(() => {
       map.invalidateSize();
    }, 100);

    // Handle arbitrary focused location
    if (focusedLocation) {
        map.setView([focusedLocation.lat, focusedLocation.lng], 15, { animate: true });
        
        // Add a temporary marker for the focused location
        const icon = L.divIcon({
            className: 'custom-icon',
            html: `<div style="background:#ef4444; width:20px; height:20px; border:3px solid white; border-radius:50%; box-shadow: 0 4px 6px rgba(0,0,0,0.3);"></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });
        
        // Remove existing temp markers
        map.eachLayer((layer: any) => {
            if (layer.options && layer.options.isTemp) {
                map.removeLayer(layer);
            }
        });

        const tempMarker = L.marker([focusedLocation.lat, focusedLocation.lng], { icon, isTemp: true }).addTo(map);
        setTimeout(() => map.removeLayer(tempMarker), 5000); // Auto remove after 5s
        return;
    }

    const layers = layerGroupRef.current;
    
    // Redraw layers
    layers.clearLayers();

    const allBounds = L.latLngBounds([]);
    const focusedBounds = L.latLngBounds([]);
    let hasFocusedPlan = focusedPlanIndex !== undefined && focusedPlanIndex !== null && plans[focusedPlanIndex];

    // Draw Origin
    if (origin) {
      L.circleMarker([origin.lat, origin.lng], {
        radius: 8,
        color: '#0b5cff',
        fillColor: '#fff',
        fillOpacity: 1
      }).addTo(layers).bindPopup(`<b>Origin:</b> ${origin.name}`);
      allBounds.extend([origin.lat, origin.lng]);
      if (hasFocusedPlan) focusedBounds.extend([origin.lat, origin.lng]);
    }

    // Draw Plans
    const colors = ['#2563eb', '#16a34a', '#dc2626']; // blue, green, red
    
    // Store lines to ensure focused one is brought to front at the end
    const drawnLines: { index: number, polyline: any }[] = [];

    plans.forEach((plan, index) => {
      if (plan.polyline && plan.polyline.length > 0) {
        const isFocused = focusedPlanIndex === index;
        // Dim other lines if one is focused
        const isDimmed = hasFocusedPlan && !isFocused;
        
        const color = colors[index % colors.length];
        const weight = isFocused ? 6 : 4;
        const opacity = isDimmed ? 0.3 : 0.8;
        const zIndexOffset = isFocused ? 1000 : 0;

        // Polyline
        const polyline = L.polyline(plan.polyline, { 
          color, 
          weight, 
          opacity,
          lineCap: 'round',
          lineJoin: 'round',
          className: 'cursor-pointer focus:outline-none' 
        }).addTo(layers);

        drawnLines.push({ index, polyline });

        // Interaction Handlers
        polyline.on('click', (e: any) => {
          L.DomEvent.stopPropagation(e);
          if (onPlanSelect) {
            onPlanSelect(index);
          }
          polyline.bringToFront();
        });

        polyline.on('mouseover', function(this: any) {
          this.setStyle({ 
            weight: isFocused ? 8 : 7, 
            opacity: 1 
          });
          this.bringToFront();
        });

        polyline.on('mouseout', function(this: any) {
          this.setStyle({ 
            weight, 
            opacity 
          });
          // If we are not the focused plan, we might have covered it.
          // Re-stack focused plan on top.
          if (!isFocused && hasFocusedPlan) {
             const focusedLine = drawnLines.find(l => l.index === focusedPlanIndex);
             if (focusedLine) focusedLine.polyline.bringToFront();
          }
        });
        
        // Destination Marker (simplification: draw last point)
        const last = plan.polyline[plan.polyline.length - 1];
        if (last) {
          const markerSize = isFocused ? 16 : 12;
          const icon = L.divIcon({
            className: 'custom-icon',
            html: `<div style="background:${color}; width:${markerSize}px; height:${markerSize}px; border:2px solid white; border-radius:50%; box-shadow: 0 2px 4px rgba(0,0,0,0.2);"></div>`,
            iconSize: [markerSize, markerSize],
            iconAnchor: [markerSize/2, markerSize/2]
          });
          
          const marker = L.marker(last, { icon, zIndexOffset }).addTo(layers);
          
          marker.bindPopup(`<b>${plan.destination}</b><br/>${plan.title}<br/><span style="font-size:0.8em; color: #666">Click to select</span>`);
          marker.on('click', () => {
            if (onPlanSelect) onPlanSelect(index);
          });
          
          // Extend bounds
          allBounds.extend(last);
          plan.polyline.forEach(pt => allBounds.extend(pt));
          
          if (isFocused) {
            focusedBounds.extend(last);
            plan.polyline.forEach(pt => focusedBounds.extend(pt));
          }
        }
      }
    });

    // Ensure focused plan is visually on top initially
    if (hasFocusedPlan) {
      const focusedLine = drawnLines.find(l => l.index === focusedPlanIndex);
      if (focusedLine) {
        setTimeout(() => focusedLine.polyline.bringToFront(), 0);
      }
    }

    // Fit Bounds logic
    if (hasFocusedPlan && focusedBounds.isValid()) {
      map.fitBounds(focusedBounds, { padding: [50, 50], animate: true });
    } else if (allBounds.isValid()) {
      map.fitBounds(allBounds, { padding: [50, 50], animate: true });
    }

  }, [origin, plans, focusedPlanIndex, onPlanSelect, focusedLocation]);

  // Inline styles to force height and background, overriding potential Tailwind issues
  return (
    <div 
      className="relative w-full rounded-xl border border-slate-200 z-0 overflow-hidden" 
      style={{ height: '460px', backgroundColor: '#f8fafc', minHeight: '460px' }}
    >
      <div 
        id={mapContainerId} 
        className="w-full h-full"
        style={{ width: '100%', height: '100%' }}
      />
      {isLoading && (
        <div className="absolute inset-0 z-[2000] bg-white/60 backdrop-blur-sm flex flex-col items-center justify-center text-slate-600 font-bold transition-all duration-300">
          <svg className="animate-spin h-10 w-10 text-blue-600 mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span className="text-sm tracking-wide">Updating Map...</span>
        </div>
      )}
    </div>
  );
};

export default MapView;
