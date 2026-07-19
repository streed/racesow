enum eMenuItems
{
    MI_EMPTY,
    MI_RESTART_RACE,
    MI_ENTER_PRACTICE,
    MI_LEAVE_PRACTICE,
    MI_NOCLIP_ON,
    MI_NOCLIP_OFF,
    MI_SAVE_POSITION,
    MI_LOAD_POSITION,
    MI_CLEAR_POSITION,
    MI_REVERSE_START,
    MI_REVERSE_LOCK,
    MI_REVERSE_OFF,
    MI_SHOW_TRIGGERS,
    MI_HIDE_TRIGGERS
};

// Each entry is '"<label>" "<command>" ' — the second token is the client
// command run on click, dispatched by GT_Command (the trailing space separates
// concatenated items). The reverse items map to the tri-state /reverse command
// (enable -> lock in -> leave); setQuickMenu() picks the label for the state.
array<const String@> menuItems = {
    '"" ""',
    '"Restart race" "racerestart"',
    '"Enter practice mode" "practicemode" ',
    '"Leave practice mode" "practicemode" ',
    '"Enable noclip mode" "noclip" ',
    '"Disable noclip mode" "noclip" ',
    '"Save position" "position save" ',
    '"Load saved position" "position load" ',
    '"Clear saved position" "position clear" ',
    '"Race in reverse" "reverse" ',
    '"Lock in reverse start" "reverse" ',
    '"Leave reverse mode" "reverse off" ',
    '"Show triggers" "showtriggers" ',
    '"Hide triggers" "showtriggers" '
};
