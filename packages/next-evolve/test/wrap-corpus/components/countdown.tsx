import { memo } from "react";

type CountdownProps = { label: string; endsAt: Date; urgent?: boolean };

function CountdownInner({ label, endsAt, urgent }: CountdownProps) {
  return (
    <p data-urgent={urgent || undefined}>
      {label} <time dateTime={endsAt.toISOString()}>{endsAt.toDateString()}</time>
    </p>
  );
}

export const Countdown = memo(CountdownInner);
