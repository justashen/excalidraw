import {
  loginIcon,
  ExcalLogo,
  eyeIcon,
  TrashIcon,
} from "@excalidraw/excalidraw/components/icons";
import { MainMenu } from "@excalidraw/excalidraw/index";
import React from "react";

import { isDevEnv } from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";

import { LanguageList } from "../app-language/LanguageList";

import { saveDebugState } from "./DebugCanvas";

export const AppMainMenu: React.FC<{
  onCollabDialogOpen: () => any;
  onTeamsLoginOpen: () => void;
  isCollaborating: boolean;
  isCollabEnabled: boolean;
  theme: Theme | "system";
  refresh: () => void;
}> = React.memo((props) => {
  return (
    <MainMenu>
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      {props.isCollabEnabled && (
        <MainMenu.DefaultItems.LiveCollaborationTrigger
          isCollaborating={props.isCollaborating}
          onSelect={() => props.onCollabDialogOpen()}
        />
      )}
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.Separator />

      <MainMenu.Item
        icon={loginIcon}
        onSelect={props.onTeamsLoginOpen}
        className="highlighted"
      >
        {localStorage.getItem("team_jwt")
          ? "Teams Dashboard"
          : "Login to Teams"}
      </MainMenu.Item>
      {localStorage.getItem("team_jwt") && (
        <MainMenu.Item
          icon={TrashIcon}
          onSelect={() => {
            localStorage.removeItem("team_jwt");
            window.location.reload();
          }}
        >
          Log Out
        </MainMenu.Item>
      )}
      {isDevEnv() && (
        <MainMenu.Item
          icon={eyeIcon}
          onSelect={() => {
            if (window.visualDebug) {
              delete window.visualDebug;
              saveDebugState({ enabled: false });
            } else {
              window.visualDebug = { data: [] };
              saveDebugState({ enabled: true });
            }
            props?.refresh();
          }}
        >
          Visual Debug
        </MainMenu.Item>
      )}
      <MainMenu.Separator />
      <MainMenu.DefaultItems.Preferences />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={props.theme} />
      <MainMenu.ItemCustom>
        <LanguageList style={{ width: "100%" }} />
      </MainMenu.ItemCustom>
      <MainMenu.DefaultItems.ChangeCanvasBackground />
      <MainMenu.Separator />
      <MainMenu.ItemCustom>
        <div style={{ fontSize: "0.75rem", color: "var(--color-gray-50)", textAlign: "center", padding: "0.5rem 0", cursor: "default" }}>
          Made possible by the Excalidraw open-source project.
        </div>
      </MainMenu.ItemCustom>
    </MainMenu>
  );
});
