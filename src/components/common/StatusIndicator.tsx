import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  MinusCircle,
  PowerOff,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import type {
  AuditOutcome,
  ProjectStatus,
  StorageState,
  SystemState,
} from '../../types/commandCenter';

interface StatusIndicatorProps {
  state: SystemState | AuditOutcome | StorageState | ProjectStatus;
  inverted?: boolean;
}

export function StatusIndicator({ state, inverted = false }: StatusIndicatorProps) {
  const renderIcon = () => {
    switch (state) {
      case 'ONLINE':
      case 'READY':
      case 'PASS':
      case 'AVAILABLE':
      case 'ACTIVE':
        return <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />;
      case 'BUSY':
      case 'PARTIAL':
      case 'PAUSED':
        return <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />;
      case 'WARNING':
      case 'READ_ONLY':
      case 'BLOCKED':
        return <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />;
      case 'ERROR':
      case 'FAIL':
      case 'NOT_AUTHORIZED':
      case 'WRITE_TEST_FAILED':
      case 'VERIFY_FAILED':
        return <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />;
      case 'OFFLINE':
      case 'NOT_FOUND':
      case 'NOT_MOUNTED':
      case 'STOPPED':
        return <PowerOff className="h-4 w-4 shrink-0" aria-hidden="true" />;
      case 'NOT CONFIGURED':
      case 'ARCHIVED':
        return <MinusCircle className="h-4 w-4 shrink-0" aria-hidden="true" />;
      default:
        return <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />;
    }
  };

  const colorClass = (() => {
    if (inverted) {
      switch (state) {
        case 'ONLINE':
        case 'READY':
        case 'PASS':
        case 'AVAILABLE':
        case 'ACTIVE':
          return 'text-[#F3D989]';
        case 'WARNING':
        case 'BUSY':
        case 'PARTIAL':
        case 'READ_ONLY':
        case 'PAUSED':
          return 'text-amber-300';
        case 'ERROR':
        case 'FAIL':
        case 'NOT_AUTHORIZED':
        case 'WRITE_TEST_FAILED':
        case 'VERIFY_FAILED':
          return 'text-red-300';
        default:
          return 'text-[#FFF8E8]/75';
      }
    }

    switch (state) {
      case 'ONLINE':
      case 'READY':
      case 'PASS':
      case 'AVAILABLE':
      case 'ACTIVE':
        return 'text-emerald-800';
      case 'BUSY':
      case 'PARTIAL':
      case 'WARNING':
      case 'READ_ONLY':
      case 'BLOCKED':
      case 'PAUSED':
        return 'text-amber-800';
      case 'ERROR':
      case 'FAIL':
      case 'NOT_AUTHORIZED':
      case 'WRITE_TEST_FAILED':
      case 'VERIFY_FAILED':
        return 'text-red-800';
      case 'OFFLINE':
      case 'NOT_FOUND':
      case 'NOT_MOUNTED':
      case 'NOT CONFIGURED':
      case 'STOPPED':
      case 'ARCHIVED':
      case 'INFO':
        return 'text-[#523624]';
      default:
        return 'text-[#26170F]';
    }
  })();

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-xs font-semibold tracking-wide whitespace-nowrap shrink-0 ${colorClass}`}
    >
      {renderIcon()}
      <span>{state}</span>
    </span>
  );
}
