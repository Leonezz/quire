import { Menu as AriaMenu, MenuItem as AriaMenuItem, MenuTrigger, Popover, composeRenderProps, type MenuItemProps, type MenuProps, type MenuTriggerProps } from "react-aria-components";
import { cx } from "../cx";

export { MenuTrigger };
export type { MenuTriggerProps };

export function Menu<T extends object>({ className, ...props }: MenuProps<T>) {
  return (
    <Popover placement="bottom end" offset={6} className="glass-strong min-w-44 rounded-card p-1.5 entering:animate-in exiting:animate-out">
      <AriaMenu {...props} className={composeRenderProps(className, (cls) => cx("outline-none", cls))} />
    </Popover>
  );
}

export function MenuItem({ className, ...props }: MenuItemProps & { destructive?: boolean }) {
  const { destructive, ...rest } = props as MenuItemProps & { destructive?: boolean };
  return (
    <AriaMenuItem
      {...rest}
      className={composeRenderProps(className, (cls) => cx(
        "flex cursor-default items-center gap-2 rounded-control px-2.5 py-1.5 text-[13.5px] text-label outline-none data-[focused]:bg-accent data-[focused]:text-on-accent",
        destructive && "text-red data-[focused]:bg-red",
        cls,
      ))}
    />
  );
}
