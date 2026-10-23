import { cn } from '../../lib/utils';

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
}

export const Progress = ({ value, className, ...props }: ProgressProps): React.JSX.Element => (
  <div className={cn('progress', className)} {...props}>
    <div
      className="progress-indicator"
      style={{
        transform: `translateX(-${Math.max(0, 100 - Math.min(100, Math.max(0, value ?? 0)))}%)`,
      }}
    />
  </div>
);
