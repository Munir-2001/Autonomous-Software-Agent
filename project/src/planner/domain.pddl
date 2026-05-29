;; Deliveroo planning domain (slide-08 §7 expanded).
;;
;; Models the BDI agent's full task at the symbolic level so PDDL can
;; reason about complete pickup/delivery cycles, not just pathfinding.
;;
;; Three distinct goal patterns exercise this domain:
;;   1. (at ?t)               — goto a tile (used by explore / goto / sidestep)
;;   2. (carrying ?p)         — pick up a specific parcel
;;   3. (delivered ?p)        — deliver a specific (currently-carried or world)
;;                              parcel to a delivery tile
;;
;; The agent is implicit (only one of us). Tiles are objects connected
;; by a bi-directional `adjacent` relation. Parcels are first-class
;; objects with `parcel-at` / `carrying` / `delivered` lifecycle.
;;
;; Move action precondition mirrors the server's rules exactly.
;; Pickup / putdown match the BDI's executor semantics.

(define (domain deliveroo)

  (:requirements :typing :negative-preconditions)

  (:types
    tile
    parcel
  )

  (:predicates
    ;; Agent state
    (at ?t - tile)
    (carrying ?p - parcel)

    ;; World state
    (adjacent ?t1 - tile ?t2 - tile)
    (walkable ?t - tile)
    (parcel-at ?p - parcel ?t - tile)
    (delivery-tile ?t - tile)
    (delivered ?p - parcel)
  )

  ;; ----- Movement -----
  (:action move
    :parameters (?from - tile ?to - tile)
    :precondition (and
      (at ?from)
      (adjacent ?from ?to)
      (walkable ?to)
    )
    :effect (and
      (not (at ?from))
      (at ?to)
    )
  )

  ;; ----- Pickup a parcel from the agent's current tile -----
  (:action pickup
    :parameters (?p - parcel ?t - tile)
    :precondition (and
      (at ?t)
      (parcel-at ?p ?t)
    )
    :effect (and
      (carrying ?p)
      (not (parcel-at ?p ?t))
    )
  )

  ;; ----- Putdown a carried parcel on a delivery tile -----
  ;; Goal-driven: putdown only fires on delivery tiles, which is the
  ;; only state transition that yields (delivered ?p) — encouraging
  ;; the planner to route to a delivery tile before dropping.
  (:action putdown
    :parameters (?p - parcel ?t - tile)
    :precondition (and
      (at ?t)
      (carrying ?p)
      (delivery-tile ?t)
    )
    :effect (and
      (not (carrying ?p))
      (delivered ?p)
    )
  )

)
