//Credit: https://github.com/jessebofill/DeckWebBrowser

import { Dropdown, findInReactTree, FooterLegendProps, getReactRoot } from "@decky/ui"
import { FC, ReactElement, ReactNode } from "react"
import { FaDiscord } from "react-icons/fa"

interface MainMenuItemPropsBase {
    route: string
    label: ReactNode
    onFocus: () => void
    icon?: ReactElement
    onActivate?: () => void
}

type MainMenuItemProps = MainMenuItemPropsBase & FooterLegendProps;

const getReactTree = () => {
    const root = document.getElementById('root');
    if (!root) return null;
    return getReactRoot(root as any);
}

const tryApplyPatch = (): (() => void) | null => {
    const tree = getReactTree();
    if (!tree) return null;
    const menuNode = findInReactTree(tree, (node: { memoizedProps: { navID: string } }) => node?.memoizedProps?.navID == 'MainNavMenuContainer')
    if (!menuNode || !menuNode.return?.type) return null

    const orig = menuNode.return.type
    let patchedInnerMenu: any
    let origInnerType: any
    const menuWrapper = (props: any) => {
        const ret = orig(props)
        if (!ret?.props?.children?.props?.children?.[0]?.type) {
            console.log('Steamcord: menu element not at expected location, Valve may have changed it.')
            return ret
        }
        const elt = ret.props.children.props.children[0];
        if (patchedInnerMenu) {
            // Only re-apply if element still has original type (was reset by React).
            // Never apply to a completely different element — that causes React #130.
            if (elt.type === origInnerType) {
                elt.type = patchedInnerMenu;
            }
        } else {
            // Manual wrap without Object.assign — avoids triggering FCTrampoline getters
            // that DeckyLoader installs on Steam component classes via contextType
            origInnerType = elt.type;
            elt.type = function (this: any, ...args: any[]) {
                const innerRet = origInnerType.apply(this, args);
                const isMenuItemElt = (e: any) => e.props?.label && e.props.onFocus && e.props.route && e.type?.toString;
                const menuItems = findInReactTree(innerRet, (node: any[]) => Array.isArray(node) && node.some(isMenuItemElt)) as Array<any>;

                if (!menuItems) {
                    console.log('Steamcord: could not find menu items to patch.')
                    return innerRet
                }

                const itemIndexes = getMenuItemIndexes(menuItems);
                const menuItem = menuItems.find(isMenuItemElt) as { props: MainMenuItemProps, type: () => ReactElement };

                const newItem =
                    <MenuItemWrapper
                        key={'steamcord'}
                        route={'/discord'}
                        label='Discord'
                        onFocus={menuItem.props.onFocus}
                        useIconAsProp={!!menuItem.props.icon}
                        MenuItemComponent={menuItem.type}
                    />

                const browserPosition = Number.parseInt(localStorage.getItem("STEAMCORD_MENU_POSITION") || "3" as string);

                if (browserPosition === 9) menuItems.splice(itemIndexes[itemIndexes.length - 1] + 1, 0, newItem)
                else menuItems.splice(itemIndexes[browserPosition - 1], 0, newItem)

                return innerRet
            };
            patchedInnerMenu = elt.type;
        }
        return ret
    }
    menuNode.return.type = menuWrapper
    if (menuNode.return.alternate) {
        menuNode.return.alternate.type = menuNode.return.type;
    }

    return () => {
        menuNode.return.type = orig
        if (menuNode.return.alternate) menuNode.return.alternate.type = menuNode.return.type;
    }
}

export const patchMenu = () => {
    let unpatch: (() => void) | null = null
    let attempts = 0

    const MAX_ATTEMPTS = 5; // gaming mode menu is available in <10s; desktop mode → fail fast
    const attempt = () => {
        unpatch = tryApplyPatch()
        if (!unpatch) {
            if (++attempts < MAX_ATTEMPTS) {
                console.log(`Steamcord: menu patch attempt ${attempts} failed, retrying...`)
                setTimeout(attempt, 2000)
            } else {
                console.log('Steamcord: menu patch gave up after ' + MAX_ATTEMPTS + ' attempts.')
            }
        } else {
            console.log(`Steamcord: menu patch applied on attempt ${attempts + 1}`)
        }
    }
    attempt()

    return () => { if (unpatch) unpatch() }
}

function getMenuItemIndexes(items: any[]) {
    return items.flatMap((item, index) => (item && item.$$typeof && item.type !== 'div') ? index : [])
}

interface MenuItemWrapperProps extends MainMenuItemProps {
    MenuItemComponent: FC<MainMenuItemProps>;
    useIconAsProp: boolean;
}

const MenuItemWrapper: FC<MenuItemWrapperProps> = ({ MenuItemComponent, label, useIconAsProp, ...props }) => {

    let choosePosition: any = null;
    try {
        if (Dropdown) {
            choosePosition = new (Dropdown as any)({
                rgOptions: [
                    { label: '1', data: 1 },
                    { label: '2', data: 2 },
                    { label: '3', data: 3 },
                    { label: '4', data: 4 },
                    { label: '5', data: 5 },
                    { label: '6', data: 6 },
                    { label: '7', data: 7 },
                    { label: '8', data: 8 },
                    { label: '9', data: 9 },
                ],
                selectedOption: 1,
                onChange: (data: any) => {
                    localStorage.setItem("STEAMCORD_MENU_POSITION", data.data);
                    patchMenu();
                }
            });
        }
    } catch (e) {
        console.error("[Steamcord] Dropdown init failed:", e);
    }

    (props as any)[useIconAsProp ? 'icon' : 'children'] = <FaDiscord />;

    return (
        <MenuItemComponent
            {...props}
            label={'Discord'}
            {...(choosePosition ? {
                onSecondaryActionDescription: "Change Position",
                onSecondaryButton: (_: any) => choosePosition.ShowMenu()
            } : {})}
        />
    )
}