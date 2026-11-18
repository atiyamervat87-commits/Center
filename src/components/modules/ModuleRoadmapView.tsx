import { CheckCircle2, Clock } from 'lucide-react';
import { t } from '../../i18n/translations';
import type { ArchitectureModuleInfo, Locale } from '../../types/commandCenter';

interface ModuleRoadmapViewProps {
  locale: Locale;
  modules: ArchitectureModuleInfo[];
}

export function ModuleRoadmapView({ locale, modules }: ModuleRoadmapViewProps) {
  const copy = t(locale);

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-xl sm:text-2xl font-bold text-[#26170F]">{copy.roadmapTitle}</h1>
        <p className="text-sm text-[#523624] max-w-3xl">{copy.roadmapSubtitle}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {modules.map((mod) => {
          const isActive = mod.status === 'ACTIVE';
          return (
            <div
              key={mod.id}
              className={`rounded-xl border p-5 space-y-2.5 ${
                isActive
                  ? 'bg-[#3B2419] text-[#FFF8E8] border-[#D4AF37]/50'
                  : 'bg-white/70 text-[#26170F] border-[#523624]/20'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span
                  className={`font-mono text-xs font-bold ${
                    isActive ? 'text-[#F3D989]' : 'text-[#8A6204]'
                  }`}
                >
                  {mod.phase}
                </span>

                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap shrink-0 ${
                    isActive ? 'text-[#F3D989]' : 'text-[#523624]'
                  }`}
                >
                  {isActive ? (
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Clock className="h-4 w-4" aria-hidden="true" />
                  )}
                  <span>{isActive ? copy.phaseActiveLabel : copy.phasePlannedLabel}</span>
                </span>
              </div>

              <h2 className="text-base font-bold">
                {locale === 'ar' ? mod.nameAr : mod.nameEn}
              </h2>

              <p
                className={`text-xs leading-relaxed ${
                  isActive ? 'text-[#FFF8E8]/85' : 'text-[#523624]'
                }`}
              >
                {locale === 'ar' ? mod.descriptionAr : mod.descriptionEn}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
