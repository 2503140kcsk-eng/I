use shogi::bitboard::Factory as BBFactory;
use shogi::{Move, Position};
use std::sync::Once;

const INITIAL_SFEN: &str = "4k4/9/9/9/9/9/9/9/4K4 b - 1";
const SHUTTLE: [&str; 8] = [
    "5i5h", "5a5b", "5h5i", "5b5a",
    "5i5h", "5a5b", "5h5i", "5b5a",
];

static INIT: Once = Once::new();

fn initialize_bitboards() {
    INIT.call_once(BBFactory::init);
}

fn moves_text() -> String {
    SHUTTLE.join(" ")
}

fn parsed_moves() -> Vec<Move> {
    SHUTTLE
        .iter()
        .map(|raw| Move::from_sfen(raw).expect("valid king shuttle move"))
        .collect()
}

#[test]
fn direct_make_move_replay_keeps_all_eight_plies() {
    initialize_bitboards();
    let mut position = Position::new();
    position.set_sfen(INITIAL_SFEN).expect("valid initial SFEN");

    for mv in parsed_moves() {
        position.make_move(mv).expect("three occurrences are not fourfold repetition");
    }

    assert_eq!(position.move_history().len(), 8);
}

#[test]
fn pinned_0122_bulk_sfen_replay_records_a_premature_repetition() {
    initialize_bitboards();
    let mut position = Position::new();
    let record = format!("{INITIAL_SFEN} moves {}", moves_text());

    // set_sfen's current implementation returns Ok after breaking on the
    // repetition error, even though the eighth move has already changed ply
    // and the board but has not been appended to move_history.
    position.set_sfen(&record).expect("the loader swallows the replay error");

    // Three actual occurrences (initial, after ply 4, after ply 8) must not
    // trigger fourfold repetition. The pinned source currently logs each
    // successful replayed position twice and truncates this final move.
    assert_eq!(
        position.move_history().len(),
        7,
        "upstream 0.12.2 replay behavior changed: re-audit before updating the pin"
    );
}
