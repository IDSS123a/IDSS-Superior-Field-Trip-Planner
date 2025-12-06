import React, { useState } from 'react';

interface SearchCardProps {
  title: string;
  icon: React.ReactNode;
  placeholder?: string;
  buttonText: string;
  onSearch: (query: string) => Promise<void>;
  isLoading: boolean;
  result: React.ReactNode | null;
  error: string | null;
  isLocationBtn?: boolean;
}

const SearchCard: React.FC<SearchCardProps> = ({ 
  title, 
  icon, 
  placeholder, 
  buttonText, 
  onSearch, 
  isLoading, 
  result, 
  error,
  isLocationBtn = false
}) => {
  const [query, setQuery] = useState('');

  const handleSubmit = () => {
    onSearch(query);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
  };

  return (
    <div className="bg-white rounded-xl shadow-md border border-slate-200 p-6 hover:shadow-lg transition-shadow duration-300">
      <div className="flex items-center gap-2 mb-4 text-slate-700">
        {icon}
        <h2 className="text-lg font-bold">{title}</h2>
      </div>

      <div className="flex flex-col gap-3">
        {!isLocationBtn && (
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="w-full px-4 py-2 rounded-lg border border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none transition-all"
          />
        )}

        <button
          onClick={handleSubmit}
          disabled={isLoading}
          className={`w-full py-2.5 px-4 rounded-lg font-semibold text-white shadow-sm transition-all transform active:scale-[0.98]
            ${isLoading 
              ? 'bg-slate-400 cursor-not-allowed' 
              : 'bg-blue-600 hover:bg-blue-700'
            }`}
        >
          {isLoading ? (
            <div className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Processing...
            </div>
          ) : (
            buttonText
          )}
        </button>
      </div>

      {/* Results Area */}
      <div className="mt-4 min-h-[3rem]">
        {error && (
          <div className="p-3 bg-red-50 border-l-4 border-red-500 text-red-700 text-sm rounded-r">
            {error}
          </div>
        )}
        {result && !error && (
          <div className="p-3 bg-emerald-50 border-l-4 border-emerald-500 text-emerald-800 text-sm rounded-r">
            {result}
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchCard;