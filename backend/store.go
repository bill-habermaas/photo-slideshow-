package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Selection is a photo chosen for display mode. The display-sized image is
// cached in the document so the slideshow plays straight from MongoDB.
type Selection struct {
	ID          string    `bson:"_id" json:"id"`
	Name        string    `bson:"name" json:"name"`
	Path        string    `bson:"path" json:"path"`
	Seconds     int       `bson:"seconds" json:"seconds"`
	Caption     string    `bson:"caption" json:"caption"`
	Width       int       `bson:"width" json:"width"`
	Height      int       `bson:"height" json:"height"`
	ContentType string    `bson:"contentType" json:"-"`
	Image       []byte    `bson:"image,omitempty" json:"-"`
	CreatedAt   time.Time `bson:"createdAt" json:"createdAt"`
	UpdatedAt   time.Time `bson:"updatedAt" json:"updatedAt"`
}

// SelectionStore is what the HTTP server needs from persistence. *Store
// implements it with MongoDB; the tests use an in-memory fake.
type SelectionStore interface {
	List(ctx context.Context) ([]Selection, error)
	Exists(ctx context.Context, id string) (bool, error)
	Insert(ctx context.Context, sel Selection) error
	UpdateOptions(ctx context.Context, id string, seconds int, caption string) error
	Get(ctx context.Context, id string) (*Selection, error)
	Image(ctx context.Context, id string) (*Selection, error)
	Delete(ctx context.Context, id string) error
	// DeleteAllSelections unselects every photo and returns how many were removed.
	DeleteAllSelections(ctx context.Context) (int64, error)
	// ClearAll removes every document from every collection (selections and settings).
	ClearAll(ctx context.Context) error
	LastFolder(ctx context.Context) (string, error)
	SetLastFolder(ctx context.Context, folder string) error
	// MountedRoot is the host photo folder the stored data came from.
	MountedRoot(ctx context.Context) (string, error)
	SetMountedRoot(ctx context.Context, root string) error
}

var _ SelectionStore = (*Store)(nil)

type Store struct {
	client   *mongo.Client
	coll     *mongo.Collection
	settings *mongo.Collection
}

// LastFolder returns the most recently scanned folder ("" if none).
func (s *Store) LastFolder(ctx context.Context) (string, error) {
	var doc struct {
		Folder string `bson:"folder"`
	}
	err := s.settings.FindOne(ctx, bson.D{{Key: "_id", Value: "app"}}).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return "", nil
	}
	return doc.Folder, err
}

// SetLastFolder remembers the scanned folder so a reload restores the list.
func (s *Store) SetLastFolder(ctx context.Context, folder string) error {
	_, err := s.settings.UpdateByID(ctx, "app",
		bson.D{{Key: "$set", Value: bson.D{{Key: "folder", Value: folder}}}},
		options.UpdateOne().SetUpsert(true))
	return err
}

// MountedRoot returns the host photo folder recorded with the stored data.
func (s *Store) MountedRoot(ctx context.Context) (string, error) {
	var doc struct {
		Root string `bson:"mountedRoot"`
	}
	err := s.settings.FindOne(ctx, bson.D{{Key: "_id", Value: "app"}}).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return "", nil
	}
	return doc.Root, err
}

// SetMountedRoot records which host photo folder the stored data came from.
func (s *Store) SetMountedRoot(ctx context.Context, root string) error {
	_, err := s.settings.UpdateByID(ctx, "app",
		bson.D{{Key: "$set", Value: bson.D{{Key: "mountedRoot", Value: root}}}},
		options.UpdateOne().SetUpsert(true))
	return err
}

func NewStore(ctx context.Context, uri, dbName string) (*Store, error) {
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		return nil, err
	}
	if err := client.Ping(ctx, nil); err != nil {
		_ = client.Disconnect(context.Background())
		return nil, err
	}
	db := client.Database(dbName)
	return &Store{client: client, coll: db.Collection("selections"), settings: db.Collection("settings")}, nil
}

func (s *Store) Close(ctx context.Context) error { return s.client.Disconnect(ctx) }

// List returns every selection without the image bytes, ordered by path.
func (s *Store) List(ctx context.Context) ([]Selection, error) {
	opts := options.Find().
		SetSort(bson.D{{Key: "path", Value: 1}}).
		SetProjection(bson.D{{Key: "image", Value: 0}})
	cur, err := s.coll.Find(ctx, bson.D{}, opts)
	if err != nil {
		return nil, err
	}
	out := []Selection{}
	if err := cur.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Exists reports whether id is already selected.
func (s *Store) Exists(ctx context.Context, id string) (bool, error) {
	n, err := s.coll.CountDocuments(ctx, bson.D{{Key: "_id", Value: id}}, options.Count().SetLimit(1))
	return n > 0, err
}

// Insert adds a new selection (including its cached image).
func (s *Store) Insert(ctx context.Context, sel Selection) error {
	_, err := s.coll.InsertOne(ctx, sel)
	if mongo.IsDuplicateKeyError(err) {
		// Lost a race with another request selecting the same photo; just update the options.
		return s.UpdateOptions(ctx, sel.ID, sel.Seconds, sel.Caption)
	}
	return err
}

// UpdateOptions changes the display seconds and caption of a selection.
func (s *Store) UpdateOptions(ctx context.Context, id string, seconds int, caption string) error {
	_, err := s.coll.UpdateByID(ctx, id, bson.D{{Key: "$set", Value: bson.D{
		{Key: "seconds", Value: seconds},
		{Key: "caption", Value: caption},
		{Key: "updatedAt", Value: time.Now().UTC()},
	}}})
	return err
}

// Get returns one selection without its image.
func (s *Store) Get(ctx context.Context, id string) (*Selection, error) {
	var sel Selection
	err := s.coll.FindOne(ctx, bson.D{{Key: "_id", Value: id}},
		options.FindOne().SetProjection(bson.D{{Key: "image", Value: 0}})).Decode(&sel)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &sel, err
}

// Image returns the cached image bytes of a selection.
func (s *Store) Image(ctx context.Context, id string) (*Selection, error) {
	var sel Selection
	err := s.coll.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&sel)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &sel, err
}

func (s *Store) Delete(ctx context.Context, id string) error {
	_, err := s.coll.DeleteOne(ctx, bson.D{{Key: "_id", Value: id}})
	return err
}

func (s *Store) DeleteAllSelections(ctx context.Context) (int64, error) {
	res, err := s.coll.DeleteMany(ctx, bson.D{})
	if err != nil {
		return 0, err
	}
	return res.DeletedCount, nil
}

// ClearAll empties every collection the app uses. Documents are deleted
// (rather than the collections dropped) so indexes and permissions are kept.
func (s *Store) ClearAll(ctx context.Context) error {
	for _, c := range []*mongo.Collection{s.coll, s.settings} {
		if _, err := c.DeleteMany(ctx, bson.D{}); err != nil {
			return fmt.Errorf("clear %s: %w", c.Name(), err)
		}
	}
	return nil
}
