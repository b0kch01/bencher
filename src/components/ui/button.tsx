import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-xl border text-sm font-medium tracking-tight transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "border-slate-900/10 bg-gradient-to-b from-slate-900 to-slate-800 text-white shadow-[0_10px_28px_-16px_rgba(15,23,42,0.8)] hover:from-slate-800 hover:to-slate-700 hover:shadow-[0_12px_28px_-14px_rgba(15,23,42,0.85)]",
        secondary:
          "border-white/45 bg-white/55 text-slate-700 backdrop-blur-md shadow-[0_10px_30px_-18px_rgba(15,23,42,0.45)] hover:bg-white/70 hover:text-slate-900",
        outline:
          "border-slate-300/70 bg-white/30 text-slate-700 backdrop-blur-md hover:border-slate-400/70 hover:bg-white/50 hover:text-slate-900"
      },
      size: {
        default: "h-10 px-4",
        sm: "h-9 px-3.5",
        lg: "h-11 px-8"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
