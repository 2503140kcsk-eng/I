//! External conformance probe for nozaq/shogi-rs.
//! This file only uses the crate's public API; no upstream source is copied.
use shogi::bitboard::Factory as BBFactory;
use shogi::{Move, Piece, PieceType, Position, Square};
use std::env;
use std::process;

fn main() {
    BBFactory::init();
    let sfen = env::args().skip(1).collect::<Vec<_>>().join(" ");
    if sfen.is_empty() {
        eprintln!("usage: cfe-shogi-rs-probe '<four-field-sfen>'");
        process::exit(2);
    }

    let mut base = Position::new();
    if let Err(err) = base.set_sfen(&sfen) {
        eprintln!("SFEN rejected by shogi-rs: {err}");
        process::exit(2);
    }
    let side = base.side_to_move();
    let canonical = base.to_sfen();
    let four_fields = canonical.split_whitespace().take(4).collect::<Vec<_>>().join(" ");
    println!("SFEN\t{four_fields}");

    let mut moves: Vec<String> = Vec::new();
    // shogi-rs exposes checked make_move rather than a public legal-move list.
    // Probe the finite standard move alphabet using its own authoritative
    // transition validator. Each attempt starts from a freshly parsed base,
    // so invalid attempts cannot contaminate later trials.
    for from_index in 0..81u8 {
        let from = Square::from_index(from_index).unwrap();
        let piece = match *base.piece_at(from) {
            Some(piece) if piece.color == side => piece,
            _ => continue,
        };
        for to_index in 0..81u8 {
            if from_index == to_index { continue; }
            let to = Square::from_index(to_index).unwrap();
            // The CFE standard-shogi boundary forbids friendly captures and
            // king capture; check_move semantics alone are not the boundary.
            if let Some(target) = *base.piece_at(to) {
                if target.color == side || target.piece_type == PieceType::King {
                    continue;
                }
            }
            for promote in [false, true] {
                if promote && piece.piece_type.promote().is_none() { continue; }
                let mut candidate = Position::new();
                candidate.set_sfen(&sfen).expect("same validated SFEN");
                let action = Move::Normal { from, to, promote };
                let usi = action.to_string();
                if candidate.make_move(action).is_ok() {
                    moves.push(usi);
                }
            }
        }
    }

    for kind in [PieceType::Rook, PieceType::Bishop, PieceType::Gold,
                 PieceType::Silver, PieceType::Knight, PieceType::Lance,
                 PieceType::Pawn] {
        if base.hand(Piece { piece_type: kind, color: side }) == 0 { continue; }
        for to_index in 0..81u8 {
            let to = Square::from_index(to_index).unwrap();
            let mut candidate = Position::new();
            candidate.set_sfen(&sfen).expect("same validated SFEN");
            let action = Move::Drop { to, piece_type: kind };
            let usi = action.to_string();
            if candidate.make_move(action).is_ok() {
                moves.push(usi);
            }
        }
    }
    moves.sort();
    moves.dedup();
    for usi in moves { println!("MOVE\t{usi}"); }
}
