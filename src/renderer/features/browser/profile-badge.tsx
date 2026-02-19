import { cn } from "../../lib/utils"

interface ProfileBadgeProps {
  name: string
  color: string
  size?: "sm" | "md"
  className?: string
}

export function ProfileBadge({ name, color, size = "sm", className }: ProfileBadgeProps) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <div
        className={cn(
          "rounded-full flex-shrink-0",
          size === "sm" ? "h-2.5 w-2.5" : "h-3.5 w-3.5",
        )}
        style={{ backgroundColor: color }}
      />
      <span className={cn(
        "truncate",
        size === "sm" ? "text-xs" : "text-sm",
      )}>
        {name}
      </span>
    </div>
  )
}
